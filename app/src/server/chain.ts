import "server-only";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiParameters,
  parseGwei,
  toBytes,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AnyCheckoutVaultAbi } from "./abi/AnyCheckoutVault";
import { LocalForwarderAbi } from "./abi/LocalForwarder";
import { MockUSDCAbi } from "./abi/MockUSDC";
import { config } from "./config";
import type { Hex } from "./types";

export const ACTION_SETTLE = 1;
export const ACTION_REFUND = 2;

export const chain = defineChain({
  id: config.chain.id,
  name: config.chain.name,
  nativeCurrency: config.chain.isLocal
    ? { name: "Ether", symbol: "ETH", decimals: 18 }
    : { name: "USDC", symbol: "USDC", decimals: 18 }, // Arc: USDC is the gas token
  rpcUrls: { default: { http: [config.chain.rpcUrl] } },
});

export const publicClient = createPublicClient({ chain, transport: http(config.chain.rpcUrl) });

function wallet(key: Hex) {
  return createWalletClient({ chain, transport: http(config.chain.rpcUrl), account: privateKeyToAccount(key) });
}

export const operatorAccount = () => privateKeyToAccount(config.chain.operatorKey);

// ---------------- units ----------------

/** USDC has 6 decimals, so 1 cent = 10_000 units. */
export const unitsFromCents = (cents: number): bigint => BigInt(Math.round(cents)) * 10_000n;
export const centsFromUnits = (units: bigint): number => Number(units / 10_000n);
export const refHash = (s: string): Hex => keccak256(toBytes(s));
export const holdIdFor = (intentId: string): Hex => keccak256(toBytes(intentId));

// ---------------- tx plumbing ----------------

type G = typeof globalThis & { __txQueue?: Promise<unknown> };
const g = globalThis as G;

/** Serialize operator transactions so nonces never collide. */
function withTxLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = (g.__txQueue ?? Promise.resolve()).then(fn, fn);
  g.__txQueue = next.catch(() => undefined);
  return next;
}

async function feeOverrides() {
  if (config.chain.isLocal) return {};
  // Arc's mempool has a 20 gwei maxFeePerGas floor (fees are paid in USDC).
  const est = await publicClient.estimateFeesPerGas().catch(() => null);
  const floor = parseGwei("25");
  const maxFeePerGas = est?.maxFeePerGas && est.maxFeePerGas > floor ? est.maxFeePerGas : floor;
  const maxPriorityFeePerGas =
    est?.maxPriorityFeePerGas && est.maxPriorityFeePerGas < maxFeePerGas ? est.maxPriorityFeePerGas : parseGwei("1");
  return { maxFeePerGas, maxPriorityFeePerGas };
}

async function send(
  key: Hex,
  request: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] },
): Promise<Hash> {
  return withTxLock(async () => {
    const w = wallet(key);
    const fees = await feeOverrides();
    // simulate first so reverts come back with a decoded reason
    const { request: sim } = await publicClient.simulateContract({
      ...(request as Parameters<typeof publicClient.simulateContract>[0]),
      account: w.account,
    });
    const hash = await w.writeContract({ ...(sim as object), ...fees } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return hash;
  });
}

export function isConfigured() {
  return Boolean(config.chain.vault && config.chain.usdc && config.chain.operatorKey);
}

// ---------------- reads ----------------

export type VaultAccount = {
  availableCents: number;
  lockedCents: number;
  weeklyLimitCents: number;
  perPurchaseLimitCents: number;
  spentInWindowCents: number;
  remainingThisWindowCents: number;
  windowResetsAt: number;
  agentEnabled: boolean;
};

export async function readAccount(user: Hex): Promise<VaultAccount> {
  const [a, remaining, resetsAt] = await publicClient.readContract({
    address: config.chain.vault,
    abi: AnyCheckoutVaultAbi,
    functionName: "getAccount",
    args: [user],
  });
  return {
    availableCents: centsFromUnits(a.available),
    lockedCents: centsFromUnits(a.locked),
    weeklyLimitCents: centsFromUnits(a.weeklyLimit),
    perPurchaseLimitCents: centsFromUnits(a.perPurchaseLimit),
    spentInWindowCents: centsFromUnits(a.spentInWindow),
    remainingThisWindowCents: centsFromUnits(remaining),
    windowResetsAt: Number(resetsAt),
    agentEnabled: a.agentEnabled,
  };
}

export const HOLD_STATUS = ["none", "open", "settled", "refunded"] as const;

export async function readHold(holdId: Hex) {
  const h = await publicClient.readContract({
    address: config.chain.vault,
    abi: AnyCheckoutVaultAbi,
    functionName: "getHold",
    args: [holdId],
  });
  return {
    user: h.user as Hex,
    status: HOLD_STATUS[h.status] ?? "none",
    humanApproved: h.humanApproved,
    openedAt: Number(h.openedAt),
    expiresAt: Number(h.expiresAt),
    amountCents: centsFromUnits(h.amount),
    chargedCents: centsFromUnits(h.charged),
    cardRef: h.cardRef as Hex,
    approvalRef: h.approvalRef as Hex,
    chargeRef: h.chargeRef as Hex,
  };
}

export async function readUsdcBalance(address: Hex): Promise<number> {
  const bal = await publicClient.readContract({
    address: config.chain.usdc,
    abi: MockUSDCAbi,
    functionName: "balanceOf",
    args: [address],
  });
  return centsFromUnits(bal);
}

// ---------------- operator writes ----------------

export async function openHold(p: {
  holdId: Hex;
  user: Hex;
  amountCents: number;
  ttlSeconds: number;
  merchantDomain: string;
  cardId: string;
  approvalRef?: Hex;
}): Promise<Hash> {
  return send(config.chain.operatorKey, {
    address: config.chain.vault,
    abi: AnyCheckoutVaultAbi,
    functionName: "openHold",
    args: [
      {
        holdId: p.holdId,
        user: p.user,
        amount: unitsFromCents(p.amountCents),
        ttl: BigInt(p.ttlSeconds),
        merchantRef: refHash(p.merchantDomain),
        cardRef: refHash(p.cardId),
        approvalRef: p.approvalRef ?? ("0x" + "00".repeat(32)) as Hex,
      },
    ],
  });
}

export async function cancelHold(holdId: Hex): Promise<Hash> {
  return send(config.chain.operatorKey, {
    address: config.chain.vault,
    abi: AnyCheckoutVaultAbi,
    functionName: "cancelHold",
    args: [holdId],
  });
}

export async function expireHold(holdId: Hex): Promise<Hash> {
  return send(config.chain.operatorKey, {
    address: config.chain.vault,
    abi: AnyCheckoutVaultAbi,
    functionName: "expireHold",
    args: [holdId],
  });
}

/** Same report layout the CRE workflow writes: (vault, action, holdId, charged, ref). */
export function encodeReport(p: { action: number; holdId: Hex; chargedCents: number; ref: Hex }): Hex {
  return encodeAbiParameters(parseAbiParameters("address, uint8, bytes32, uint256, bytes32"), [
    config.chain.vault,
    p.action,
    p.holdId,
    unitsFromCents(p.chargedCents),
    p.ref,
  ]);
}

/** Local chain only: deliver a report through our LocalForwarder (stands in for the Chainlink forwarder). */
export async function forwardReportLocally(report: Hex): Promise<Hash> {
  if (!config.chain.localForwarder) throw new Error("LOCAL_FORWARDER_ADDRESS is not set");
  return send(config.chain.operatorKey, {
    address: config.chain.localForwarder,
    abi: LocalForwarderAbi,
    functionName: "forward",
    args: [config.chain.vault, report],
  });
}

// ---------------- demo-user helpers (local chain only) ----------------

function demoKey(): Hex {
  if (!config.chain.isLocal || !config.chain.demoUserKey) {
    throw new Error("Demo wallet actions only run on the local chain. On testnet, use your own wallet.");
  }
  return config.chain.demoUserKey;
}

export async function demoSetPolicy(weeklyCents: number, perPurchaseCents: number, enabled: boolean) {
  return send(demoKey(), {
    address: config.chain.vault,
    abi: AnyCheckoutVaultAbi,
    functionName: "setPolicy",
    args: [unitsFromCents(weeklyCents), unitsFromCents(perPurchaseCents), enabled],
  });
}

export async function demoFaucetAndDeposit(cents: number) {
  const user = privateKeyToAccount(demoKey()).address;
  await send(demoKey(), {
    address: config.chain.usdc,
    abi: MockUSDCAbi,
    functionName: "mint",
    args: [user, unitsFromCents(cents)],
  });
  await send(demoKey(), {
    address: config.chain.usdc,
    abi: MockUSDCAbi,
    functionName: "approve",
    args: [config.chain.vault, unitsFromCents(cents)],
  });
  return send(demoKey(), {
    address: config.chain.vault,
    abi: AnyCheckoutVaultAbi,
    functionName: "deposit",
    args: [unitsFromCents(cents)],
  });
}

export async function demoWithdraw(cents: number) {
  return send(demoKey(), {
    address: config.chain.vault,
    abi: AnyCheckoutVaultAbi,
    functionName: "withdraw",
    args: [unitsFromCents(cents)],
  });
}

export function explorerTx(hash?: string) {
  if (!hash || !config.chain.explorerUrl) return undefined;
  return `${config.chain.explorerUrl.replace(/\/$/, "")}/tx/${hash}`;
}

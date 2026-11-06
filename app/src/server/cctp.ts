import "server-only";
import { AnyCheckoutVaultAbi } from "./abi/AnyCheckoutVault";
import { publicClient } from "./chain";
import { config } from "./config";
import { read, write } from "./store";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Circle CCTP V2: USDC burned on the source chain (after the Uniswap swap) is minted into the
 * AnyCheckout vault on Arc. The burn names the vault as both mintRecipient and destinationCaller,
 * so only the vault can complete it, and the vault credits the depositor (the burn's messageSender).
 * This relayer just waits for Circle's attestation and calls vault.claimBridgedDeposit.
 */

export async function fastTransferFee(sourceDomain: number): Promise<{ bps: number; finality: number }> {
  try {
    const res = await fetch(`${config.cctp.irisUrl}/v2/burn/USDC/fees/${sourceDomain}/${config.cctp.destinationDomain}`, { cache: "no-store" });
    const list = (await res.json()) as { finalityThreshold: number; minimumFee: number }[];
    const fast = list.find((f) => f.finalityThreshold <= 1000);
    if (fast) return { bps: fast.minimumFee, finality: 1000 };
  } catch {
    // fall through to standard transfer
  }
  return { bps: 0, finality: 2000 }; // standard transfer: no fee, waits for source finality
}

type IrisMessage = { message: string; attestation: string; status: string; eventNonce?: string };

async function fetchAttestation(sourceDomain: number, txHash: string): Promise<IrisMessage | null> {
  const res = await fetch(`${config.cctp.irisUrl}/v2/messages/${sourceDomain}?transactionHash=${txHash}`, { cache: "no-store" });
  if (res.status === 404) return null;
  const body = (await res.json()) as { messages?: IrisMessage[] };
  const m = body.messages?.[0];
  return m && m.status === "complete" && m.attestation && m.attestation !== "PENDING" ? m : null;
}

export async function claimBridgedDeposit(sourceDomain: number, txHash: string) {
  const key = `${sourceDomain}:${txHash.toLowerCase()}`;
  const existing = read().bridgeClaims[key];
  if (existing?.status === "claimed") return existing;

  await write((db) => {
    db.bridgeClaims[key] = { txHash, sourceDomain, status: "waiting_for_attestation", at: new Date().toISOString() };
  });

  const deadline = Date.now() + 25 * 60_000;
  let msg: IrisMessage | null = null;
  while (!msg && Date.now() < deadline) {
    msg = await fetchAttestation(sourceDomain, txHash).catch(() => null);
    if (!msg) await new Promise((r) => setTimeout(r, 4000));
  }
  if (!msg) {
    await write((db) => {
      db.bridgeClaims[key] = { ...db.bridgeClaims[key], status: "timeout", error: "No attestation within 25 minutes" };
    });
    return read().bridgeClaims[key];
  }

  try {
    const wallet = createWalletClient({
      chain: publicClient.chain,
      transport: http(config.chain.rpcUrl),
      account: privateKeyToAccount(config.chain.operatorKey),
    });
    const { request } = await publicClient.simulateContract({
      address: config.chain.vault,
      abi: AnyCheckoutVaultAbi,
      functionName: "claimBridgedDeposit",
      args: [msg.message as `0x${string}`, msg.attestation as `0x${string}`],
      account: wallet.account,
    });
    const claimTx = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: claimTx });
    await write((db) => {
      db.bridgeClaims[key] = { ...db.bridgeClaims[key], status: "claimed", claimTx };
    });
  } catch (e) {
    await write((db) => {
      db.bridgeClaims[key] = { ...db.bridgeClaims[key], status: "error", error: (e as Error).message.slice(0, 300) };
    });
  }
  return read().bridgeClaims[key];
}

export function claimStatus(sourceDomain: number, txHash: string) {
  return read().bridgeClaims[`${sourceDomain}:${txHash.toLowerCase()}`] ?? null;
}

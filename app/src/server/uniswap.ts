import "server-only";
import { config } from "./config";

/**
 * Uniswap Trading API (https://developers.uniswap.org/docs/trading/swapping-api/getting-started).
 * Used for "pay with any token": the user swaps any ERC-20 into exactly the USDC they want to add
 * to their vault (EXACT_OUTPUT), on a testnet the API supports (Base Sepolia by default).
 * The API key stays on the server; the browser only signs the permit and sends the swap tx.
 */

export class UniswapError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`Uniswap API error ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

async function call<T>(path: string, body: unknown): Promise<T> {
  if (!config.uniswap.apiKey) throw new UniswapError(401, { error: "Set UNISWAP_API_KEY (developers.uniswap.org/dashboard)" });
  const res = await fetch(`${config.uniswap.apiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.uniswap.apiKey,
      // Optional attribution header for agent-built integrations.
      "X-Agent-Info": "anycheckout/0.1 (claude-code)",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new UniswapError(res.status, data);
  return data as T;
}

export const SOURCE_CHAINS: Record<number, { name: string; usdc: `0x${string}`; cctpDomain: number; rpc: string; explorer: string }> = {
  84532: {
    name: "Base Sepolia",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    cctpDomain: 6,
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
  1301: {
    name: "Unichain Sepolia",
    usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
    cctpDomain: 10,
    rpc: "https://sepolia.unichain.org",
    explorer: "https://sepolia.uniscan.xyz",
  },
  11155111: {
    name: "Ethereum Sepolia",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    cctpDomain: 0,
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
};

export function sourceChain() {
  const c = SOURCE_CHAINS[config.uniswap.chainId];
  if (!c) throw new Error(`UNISWAP_CHAIN_ID ${config.uniswap.chainId} is not one of ${Object.keys(SOURCE_CHAINS).join(", ")}`);
  return { id: config.uniswap.chainId, ...c };
}

export function checkApproval(p: { walletAddress: string; token: string; amount: string }) {
  return call<{ approval: Record<string, unknown> | null; cancel?: unknown }>("/check_approval", {
    walletAddress: p.walletAddress,
    token: p.token,
    amount: p.amount,
    chainId: sourceChain().id,
  });
}

/** Quote: pay with `tokenIn`, receive exactly `usdcOut` (6-decimal units) of USDC. */
export function quoteExactUsdcOut(p: { tokenIn: string; usdcOut: string; swapper: string }) {
  const chain = sourceChain();
  return call<{ routing: string; quote: Record<string, unknown>; permitData: Record<string, unknown> | null }>("/quote", {
    type: "EXACT_OUTPUT",
    amount: p.usdcOut,
    tokenIn: p.tokenIn,
    tokenOut: chain.usdc,
    tokenInChainId: chain.id,
    tokenOutChainId: chain.id,
    swapper: p.swapper,
    // UniswapX is mainnet-only; on testnets route through the AMM pools.
    protocols: ["V4", "V3", "V2"],
    slippageTolerance: 1,
  });
}

export function buildSwap(p: { quote: unknown; signature?: string; permitData?: unknown }) {
  return call<{ swap: { to: string; data: string; value: string; gasLimit?: string; chainId: number } }>("/swap", {
    quote: p.quote,
    ...(p.signature && p.permitData ? { signature: p.signature, permitData: p.permitData } : {}),
  });
}

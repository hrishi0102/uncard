import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { sourceChain } from "@/server/uniswap";

export const dynamic = "force-dynamic";

/** Public, non-secret settings the browser wallet flows need. */
export async function GET() {
  let source = null;
  try {
    source = sourceChain();
  } catch {
    source = null;
  }
  return NextResponse.json({
    vault: config.chain.vault,
    usdc: config.chain.usdc,
    chain: { id: config.chain.id, name: config.chain.name, rpcUrl: config.chain.rpcUrl, explorer: config.chain.explorerUrl, isLocal: config.chain.isLocal },
    source,
    cctp: { tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", destinationDomain: config.cctp.destinationDomain },
    uniswapReady: Boolean(config.uniswap.apiKey),
  });
}

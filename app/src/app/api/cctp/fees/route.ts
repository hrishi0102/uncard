import { NextResponse } from "next/server";
import { fastTransferFee } from "@/server/cctp";
import { sourceChain } from "@/server/uniswap";

export const dynamic = "force-dynamic";

export async function GET() {
  const src = sourceChain();
  return NextResponse.json(await fastTransferFee(src.cctpDomain));
}

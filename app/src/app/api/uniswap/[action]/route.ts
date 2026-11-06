import { NextRequest, NextResponse } from "next/server";
import { buildSwap, checkApproval, quoteExactUsdcOut, UniswapError } from "@/server/uniswap";

export const dynamic = "force-dynamic";

/** Server-side proxy to the Uniswap Trading API, so the API key never reaches the browser. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  const b = await req.json();
  try {
    if (action === "check_approval") return NextResponse.json(await checkApproval(b));
    if (action === "quote") return NextResponse.json(await quoteExactUsdcOut(b));
    if (action === "swap") return NextResponse.json(await buildSwap(b));
    return NextResponse.json({ error: "unknown action" }, { status: 404 });
  } catch (e) {
    if (e instanceof UniswapError) return NextResponse.json({ error: e.message, details: e.body }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

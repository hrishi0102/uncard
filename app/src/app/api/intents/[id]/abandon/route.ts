import { NextRequest, NextResponse } from "next/server";
import { abandonCheckout } from "@/server/intents";

export const dynamic = "force-dynamic";

/** Demo control: simulate the agent walking away from checkout (the card is closed, user is refunded). */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await abandonCheckout(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

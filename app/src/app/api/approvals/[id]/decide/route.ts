import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { decideApproval } from "@/server/intents";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = z.object({ decision: z.enum(["approve", "deny"]) }).safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "decision must be approve or deny" }, { status: 400 });
  try {
    const intent = await decideApproval(id, parsed.data.decision);
    return NextResponse.json({ status: intent.status });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

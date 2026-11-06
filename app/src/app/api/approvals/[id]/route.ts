import { NextRequest, NextResponse } from "next/server";
import { config } from "@/server/config";
import { ensureBackgroundLoop, getIntent, pollApproval } from "@/server/intents";
import { read } from "@/server/store";

export const dynamic = "force-dynamic";

/** Public view for the approval page. Never includes the World device_code. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  ensureBackgroundLoop();
  if (!getIntent(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const intent = (await pollApproval(id).catch(() => undefined)) ?? getIntent(id)!;
  const attempt = read().approvals[id];
  const user = read().users[intent.userId];
  return NextResponse.json({
    intent: {
      id: intent.id,
      status: intent.status,
      merchant: intent.merchant,
      amountCents: intent.amountCents,
      description: intent.description,
      reasons: intent.reasons,
      agentLabel: intent.agentLabel,
      createdAt: intent.createdAt,
      approval: intent.approval ? { status: intent.approval.status, error: intent.approval.error, world: intent.approval.world ? { acr: intent.approval.world.acr, authTime: intent.approval.world.authTime } : undefined } : undefined,
      card: intent.card ? { last4: intent.card.last4 } : undefined,
      timeline: intent.timeline,
    },
    attempt: attempt ? { userCode: attempt.userCode, verificationUri: attempt.verificationUri, verificationUriComplete: attempt.verificationUriComplete, expiresAt: attempt.expiresAt } : null,
    worldMode: config.world.mode,
    worldLinked: Boolean(user?.world),
  });
}

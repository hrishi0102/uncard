import { after, NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/server/agentcard";
import { config } from "@/server/config";
import { handleIssuerEvent } from "@/server/intents";

export const dynamic = "force-dynamic";

/** Agentcard webhooks (real sandbox or the local mock). Verify, ack fast, process after. */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("agentcard-signature");
  if (!verifyWebhookSignature(raw, sig, config.cardIssuer.webhookSecret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }
  const evt = JSON.parse(raw) as { id: string; type: string; data: Record<string, unknown> };
  after(async () => {
    try {
      await handleIssuerEvent(evt);
    } catch (e) {
      console.error("[webhook] failed to handle", evt.type, e);
    }
  });
  return NextResponse.json({ received: true });
}

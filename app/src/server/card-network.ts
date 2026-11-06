import "server-only";
import { agentcard, AgentcardError } from "./agentcard";
import { read } from "./store";

/**
 * A pretend card network for the demo shops. A real processor would route the PAN to the issuer.
 * Here we find the AnyCheckout card that matches the typed PAN/expiry/CVC and ask the issuer's
 * sandbox to run the charge (test_charge) or a decline (test_authorization outcome=declined).
 * The issuer then sends the same webhooks a real charge would.
 */

export type NetworkCharge = {
  number: string;
  expMonth: string;
  expYear: string;
  cvc: string;
  amountCents: number;
  merchant: string;
  mcc: string;
  declineReason?: string; // set when this merchant refuses virtual/prepaid cards
};

export type NetworkResult =
  | { approved: true; transactionId: string; amountCents: number; last4: string }
  | { approved: false; reason: string; last4?: string };

const digits = (s: string) => s.replace(/\D/g, "");

async function findCard(c: NetworkCharge) {
  const pan = digits(c.number);
  const candidates = Object.values(read().intents).filter(
    (i) => i.card && !i.card.closed && i.card.last4 === pan.slice(-4),
  );
  for (const i of candidates) {
    try {
      const cred = await agentcard.credentials(i.card!.id);
      const yy = (y: string) => digits(y).slice(-2);
      if (
        digits(cred.number) === pan &&
        Number(cred.exp_month) === Number(c.expMonth) &&
        yy(cred.exp_year) === yy(c.expYear) &&
        cred.cvc === digits(c.cvc)
      ) {
        return { cardId: i.card!.id, last4: cred.last4 };
      }
    } catch {
      // closed or unreadable card: not a match
    }
  }
  return null;
}

export async function chargeCard(c: NetworkCharge): Promise<NetworkResult> {
  if (digits(c.number).length < 12) return { approved: false, reason: "invalid_card_number" };
  const card = await findCard(c);
  if (!card) return { approved: false, reason: "invalid_card_details" };

  try {
    if (c.declineReason) {
      const t = await agentcard.testAuthorization(card.cardId, {
        amount_cents: c.amountCents,
        merchant: c.merchant,
        mcc: c.mcc,
        outcome: "declined",
        decline_reason: c.declineReason,
      });
      return { approved: false, reason: t.decline_reason ?? c.declineReason, last4: card.last4 };
    }
    const t = await agentcard.testCharge(card.cardId, { amount_cents: c.amountCents, merchant: c.merchant, mcc: c.mcc });
    if (t.status === "declined") return { approved: false, reason: "declined", last4: card.last4 };
    return { approved: true, transactionId: t.id, amountCents: c.amountCents, last4: card.last4 };
  } catch (e) {
    if (e instanceof AgentcardError) {
      const reason = e.code === "amount_exceeds_balance" ? "insufficient_funds" : e.code;
      return { approved: false, reason, last4: card.last4 };
    }
    throw e;
  }
}

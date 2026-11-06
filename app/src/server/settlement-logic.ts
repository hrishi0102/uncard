/**
 * The settlement decision, as a pure function. The Chainlink CRE workflow (cre/settlement/main.ts)
 * runs the same rules inside the DON; the backend uses this copy for SETTLEMENT_MODE=local.
 * Keep the two in sync.
 */

export type IssuerTxn = {
  id: string;
  status: "pending" | "authorized" | "cleared" | "declined" | "voided" | "refunded";
  amount: number | null; // cents
  decline_reason: string | null;
};

export type Decision =
  | { action: "settle"; chargedCents: number; ref: string; note: string }
  | { action: "refund"; ref: string; note: string }
  | { action: "wait"; note: string };

export function decideSettlement(p: {
  txns: IssuerTxn[];
  holdAmountCents: number;
  holdExpiresAt: number; // unix seconds
  nowSeconds: number;
  cardClosed: boolean;
}): Decision {
  const cleared = p.txns.filter((t) => t.status === "cleared");
  const chargedCents = cleared.reduce((s, t) => s + (t.amount ?? 0), 0);
  if (chargedCents > 0) {
    // A single-use card can never take more than its limit (= the hold); cap defensively anyway.
    const capped = Math.min(chargedCents, p.holdAmountCents);
    return {
      action: "settle",
      chargedCents: capped,
      ref: cleared.map((t) => t.id).sort().join(","),
      note: `merchant charged ${(capped / 100).toFixed(2)} of ${(p.holdAmountCents / 100).toFixed(2)}`,
    };
  }
  if (p.txns.some((t) => t.status === "authorized" || t.status === "pending")) {
    return { action: "wait", note: "authorization pending, not cleared yet" };
  }
  // Refund only once the card can never be charged again (closed). A decline on an open card
  // could still be followed by a successful retry, so the backend closes the card first.
  if (!p.cardClosed) return { action: "wait", note: "card still open, no cleared charge yet" };
  const declined = p.txns.find((t) => t.status === "declined" || t.status === "voided");
  if (declined) {
    return {
      action: "refund",
      ref: `DECLINED:${declined.decline_reason ?? declined.status}`,
      note: `card ${declined.status}${declined.decline_reason ? ` (${declined.decline_reason})` : ""}`,
    };
  }
  const expired = p.nowSeconds >= p.holdExpiresAt;
  return {
    action: "refund",
    ref: expired ? "TIMEOUT" : "CARD_CLOSED_UNUSED",
    note: expired ? "no charge before the card expired" : "card closed without a charge",
  };
}

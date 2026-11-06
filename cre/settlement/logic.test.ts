import { describe, expect, test } from "bun:test";
import { decideSettlement, type IssuerTxn } from "./logic";

const base = { holdAmountCents: 5448, holdExpiresAt: 1_000, nowSeconds: 500, cardClosed: true };
const tx = (p: Partial<IssuerTxn>): IssuerTxn => ({ id: "txn_1", status: "cleared", amount: 4749, decline_reason: null, ...p });

describe("decideSettlement", () => {
  test("settles exactly the cleared amount (partial capture)", () => {
    const d = decideSettlement({ ...base, txns: [tx({})] });
    expect(d).toMatchObject({ action: "settle", chargedCents: 4749, ref: "txn_1" });
  });
  test("caps a charge at the hold amount", () => {
    const d = decideSettlement({ ...base, txns: [tx({ amount: 9999 })] });
    expect(d).toMatchObject({ action: "settle", chargedCents: 5448 });
  });
  test("waits while an authorization is pending", () => {
    expect(decideSettlement({ ...base, txns: [tx({ status: "authorized" })] }).action).toBe("wait");
  });
  test("never refunds while the card is still open", () => {
    expect(decideSettlement({ ...base, cardClosed: false, txns: [tx({ status: "declined", amount: 5448 })] }).action).toBe("wait");
  });
  test("refunds a declined, closed card with the reason", () => {
    const d = decideSettlement({ ...base, txns: [tx({ status: "declined", decline_reason: "prepaid_card_not_accepted" })] });
    expect(d).toMatchObject({ action: "refund", ref: "DECLINED:prepaid_card_not_accepted" });
  });
  test("refunds an unused card that expired", () => {
    expect(decideSettlement({ ...base, nowSeconds: 2_000, txns: [] })).toMatchObject({ action: "refund", ref: "TIMEOUT" });
  });
  test("refunds an unused card closed early", () => {
    expect(decideSettlement({ ...base, txns: [] })).toMatchObject({ action: "refund", ref: "CARD_CLOSED_UNUSED" });
  });
});

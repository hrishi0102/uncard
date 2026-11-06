import "server-only";
import { randomBytes, randomInt } from "node:crypto";
import { signWebhook } from "./agentcard";
import { config } from "./config";
import { read, write } from "./store";
import type { MockCard, MockTransaction } from "./types";

/**
 * A local stand-in for the Agentcard Issuing API (same paths, payloads, errors and signed webhooks),
 * used because self-serve Agentcard sign-ups are invite-only. Mounted at /api/mock-agentcard/api/v2/*.
 * Switch to the real sandbox with CARD_ISSUER=agentcard. Nothing else changes.
 */

const MOCK_CLIENT_ID = "mock_client_id";
const MOCK_CLIENT_SECRET = "mock_client_secret";

export class MockHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
const now = () => new Date().toISOString();

function luhnPan(prefix = "400012"): string {
  let digits = prefix;
  while (digits.length < 15) digits += String(randomInt(0, 10));
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(digits[14 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits + String((10 - (sum % 10)) % 10);
}

const publicCard = (c: MockCard) => ({
  object: "card" as const,
  id: c.id,
  status: c.status,
  type: c.type,
  spend_limit_cents: c.spend_limit_cents,
  balance_cents: c.balance_cents,
  last4: c.last4,
  expiry: `${c.exp_month}/${c.exp_year.slice(2)}`,
  user_id: c.user_id,
  cardholder_name: "AnyCheckout Demo",
  billing_address: "1 Marine Drive, Mumbai 400020, IN",
  funds_source: "company_flow",
  ...(c.closed_reason ? { closed_reason: c.closed_reason } : {}),
  created_at: c.created_at,
});

const publicTxn = (t: MockTransaction) => ({
  object: "transaction" as const,
  id: t.id,
  source: "issued",
  status: t.status,
  amount: t.amount,
  currency: null,
  amount_display: null,
  merchant_amount: null,
  merchant_currency: null,
  merchant: t.merchant,
  mcc: t.mcc,
  decline_reason: t.decline_reason,
  user_id: t.user_id,
  card_id: t.card_id,
  vault_card_id: null,
  last4: read().mockIssuer.cards[t.card_id]?.last4 ?? null,
  processor_transaction_id: `sandbox_${t.id}`,
  created_at: t.created_at,
});

// ---------------- webhooks ----------------

type Outbox = { type: string; data: Record<string, unknown> }[];

async function deliver(events: Outbox) {
  const hooks = read().mockIssuer.webhooks;
  for (const ev of events) {
    const envelope = {
      id: id("evt"),
      type: ev.type,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: ev.data,
    };
    const raw = JSON.stringify(envelope);
    for (const h of hooks) {
      const match = h.enabled_events.some(
        (e) => e === "*" || e === ev.type || (e.endsWith(".*") && ev.type.startsWith(e.slice(0, -1))),
      );
      if (!match) continue;
      try {
        await fetch(h.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "AgentCard-Signature": signWebhook(raw, h.secret) },
          body: raw,
        });
      } catch (e) {
        console.warn("[mock-agentcard] webhook delivery failed", h.url, (e as Error).message);
      }
    }
  }
}

function txnEvent(t: MockTransaction, card: MockCard, status: string) {
  return {
    id: t.id,
    card_id: t.card_id,
    last4: card.last4,
    amount: t.amount,
    currency: "usd",
    amount_display: `$${(t.amount / 100).toFixed(2)}`,
    merchant: t.merchant,
    status,
    balance_cents: card.balance_cents,
    ...(t.decline_reason ? { decline_reason: t.decline_reason } : {}),
  };
}

/** Make sure our own webhook endpoint is registered with the mock (idempotent). */
export async function ensureMockWebhook() {
  const url = `${config.appUrl}/api/webhooks/agentcard`;
  if (read().mockIssuer.webhooks.some((h) => h.url === url)) return;
  await write((db) => {
    db.mockIssuer.webhooks.push({ id: id("we"), url, secret: "whsec_mock_local", enabled_events: ["card.*", "transaction.*"] });
  });
}

// ---------------- request handling ----------------

export type MockResult = { status: number; body: unknown; after?: () => Promise<void> };

function requireAuth(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer mock_token_")) throw new MockHttpError(401, "unauthorized", "Missing or invalid token");
}

export async function handleMock(
  method: string,
  path: string[],
  headers: Headers,
  body: Record<string, unknown> | URLSearchParams | null,
  query: URLSearchParams,
): Promise<MockResult> {
  const route = `${method} /${path.join("/")}`;

  // OAuth client credentials
  if (route === "POST /oauth/token") {
    const form = body instanceof URLSearchParams ? body : new URLSearchParams();
    if (form.get("client_id") !== MOCK_CLIENT_ID || form.get("client_secret") !== MOCK_CLIENT_SECRET) {
      return { status: 401, body: { error: "invalid_client" } };
    }
    return { status: 200, body: { access_token: `mock_token_${randomBytes(16).toString("hex")}`, token_type: "Bearer", expires_in: 3600, scope: "" } };
  }

  requireAuth(headers.get("authorization"));
  const b = (body && !(body instanceof URLSearchParams) ? body : {}) as Record<string, unknown>;

  // ---- connect + KYC ----
  if (route === "POST /connect/start") {
    const email = String(b.email ?? "");
    if (!email) throw new MockHttpError(400, "invalid_fields", "email is required");
    const cid = id("ca");
    await write((db) => {
      db.mockIssuer.connects[cid] = { email };
    });
    return { status: 201, body: { object: "connect_attempt", id: cid, channel: "email", expires_at: new Date(Date.now() + 600_000).toISOString() } };
  }
  if (route === "POST /connect/verify") {
    const attempt = read().mockIssuer.connects[String(b.connect_id)];
    if (!attempt) throw new MockHttpError(400, "invalid_connect_id", "Unknown connect attempt");
    if (String(b.code) !== "111111") throw new MockHttpError(400, "invalid_code", "In sandbox the code is always 111111");
    const existing = Object.values(read().mockIssuer.users).find((u) => u.email === attempt.email);
    const uid = existing?.id ?? id("usr");
    await write((db) => {
      db.mockIssuer.users[uid] ??= { id: uid, email: attempt.email, kyc: "requires_verification", consent: false };
    });
    return {
      status: 200,
      body: { object: "connection", access_token: `act_${randomBytes(8).toString("hex")}`, refresh_token: `rct_${randomBytes(8).toString("hex")}`, token_type: "Bearer", expires_in: 3600, user: { id: uid, email: attempt.email } },
    };
  }
  if (route === "POST /connect/consent") {
    const uid = String(b.user_id);
    if (!read().mockIssuer.users[uid]) throw new MockHttpError(404, "user_not_found", "No such user");
    await write((db) => {
      db.mockIssuer.users[uid].consent = true;
    });
    return { status: 201, body: { object: "consent", user_id: uid } };
  }
  if (route === "POST /kyc/simulate") {
    const uid = String(b.user_id);
    if (!read().mockIssuer.users[uid]) throw new MockHttpError(404, "user_not_found", "No such user");
    const outcome = String(b.outcome ?? "approved");
    await write((db) => {
      db.mockIssuer.users[uid].kyc = outcome;
    });
    return { status: 200, body: { object: "kyc", status: outcome } };
  }

  // ---- company wallet ----
  if (route === "GET /company_wallet") {
    const committed = Object.values(read().mockIssuer.cards)
      .filter((c) => c.status === "open")
      .reduce((s, c) => s + c.balance_cents, 0);
    const w = read().mockIssuer.walletCents;
    return { status: 200, body: { object: "company_wallet", livemode: false, balance_cents: w + committed, committed_cents: committed, available_cents: w, flow_of_funds: "company", default_funds_source: "company_flow" } };
  }
  if (route === "POST /company_wallet/test_fund") {
    const amount = Number(b.amount_cents ?? 0);
    if (!Number.isInteger(amount) || amount <= 0) throw new MockHttpError(400, "invalid_fields", "amount_cents must be a positive integer");
    await write((db) => {
      db.mockIssuer.walletCents += amount;
    });
    return { status: 200, body: { object: "company_wallet", livemode: false, available_cents: read().mockIssuer.walletCents } };
  }

  // ---- webhooks ----
  if (route === "POST /webhook_endpoints") {
    const hook = { id: id("we"), url: String(b.url), secret: `whsec_${randomBytes(16).toString("hex")}`, enabled_events: (b.enabled_events as string[]) ?? ["*"] };
    await write((db) => {
      db.mockIssuer.webhooks.push(hook);
    });
    return { status: 201, body: { object: "webhook_endpoint", ...hook } };
  }

  // ---- cards ----
  if (route === "POST /cards") {
    const uid = String(b.user_id ?? "");
    const amount = Number(b.amount_cents ?? 0);
    const key = headers.get("idempotency-key") ?? undefined;
    const user = read().mockIssuer.users[uid];
    if (!user) throw new MockHttpError(404, "user_not_found", "No such connected user");
    if (user.kyc !== "approved") throw new MockHttpError(409, "kyc_required", "The user has not verified their identity.");
    if (!Number.isInteger(amount) || amount < 100) throw new MockHttpError(400, "invalid_fields", "amount_cents must be an integer, minimum 100");
    if (key) {
      const prior = Object.values(read().mockIssuer.cards).find((c) => c.idempotency_key === key);
      if (prior) return { status: 201, body: publicCard(prior) };
    }
    if (read().mockIssuer.walletCents < amount) {
      throw new MockHttpError(409, "org_wallet_funding_required", "The company balance cannot cover this card. Add funds in the dashboard, then retry.");
    }
    const exp = new Date();
    exp.setFullYear(exp.getFullYear() + 3);
    const number = luhnPan();
    const card: MockCard = {
      id: id("card"),
      user_id: uid,
      status: "open",
      type: (b.type as MockCard["type"]) ?? "single_use",
      spend_limit_cents: amount,
      balance_cents: amount,
      number,
      cvc: String(randomInt(100, 1000)),
      exp_month: String(exp.getMonth() + 1).padStart(2, "0"),
      exp_year: String(exp.getFullYear()),
      last4: number.slice(-4),
      created_at: now(),
      idempotency_key: key,
    };
    await write((db) => {
      db.mockIssuer.walletCents -= amount;
      db.mockIssuer.cards[card.id] = card;
    });
    return { status: 201, body: publicCard(card), after: () => deliver([{ type: "card.created", data: publicCard(card) }]) };
  }

  const [, cardId, sub] = path; // ["cards", id, sub?]
  if (path[0] === "cards" && cardId) {
    const card = read().mockIssuer.cards[cardId];
    if (!card) throw new MockHttpError(404, "card_not_found", "No such card on your company, in this credential's mode.");

    if (method === "GET" && !sub) return { status: 200, body: publicCard(card) };

    if (method === "GET" && sub === "credentials") {
      if (card.status === "closed") throw new MockHttpError(410, "card_closed", "This card is closed.");
      return {
        status: 200,
        body: { object: "card_credentials", id: card.id, number: card.number, exp_month: card.exp_month, exp_year: card.exp_year, cvc: card.cvc, last4: card.last4, cardholder_name: "AnyCheckout Demo", billing_address: "1 Marine Drive, Mumbai 400020, IN" },
      };
    }

    if (method === "POST" && sub === "close") {
      if (card.status === "closed") return { status: 200, body: publicCard(card) };
      await write((db) => {
        const c = db.mockIssuer.cards[cardId];
        db.mockIssuer.walletCents += c.balance_cents; // unspent hold goes back to the company wallet
        c.balance_cents = 0;
        c.status = "closed";
        c.closed_reason = "canceled";
      });
      const closed = read().mockIssuer.cards[cardId];
      return { status: 200, body: publicCard(closed), after: () => deliver([{ type: "card.closed", data: publicCard(closed) }]) };
    }

    if (method === "POST" && (sub === "test_charge" || sub === "test_authorization")) {
      if (card.status !== "open") throw new MockHttpError(409, "card_not_open", "The card can't take a charge. A single-use card closes after its first approved charge.");
      const amount = Number(b.amount_cents ?? Math.min(675, card.balance_cents));
      const merchant = String(b.merchant ?? "SANDBOX MERCHANT");
      const mcc = String(b.mcc ?? "5812");
      const declined = sub === "test_authorization" && b.outcome === "declined";
      const overBalance = amount > card.balance_cents;
      if (sub === "test_charge" && overBalance) throw new MockHttpError(422, "amount_exceeds_balance", "The card can't cover this amount.");

      const txn: MockTransaction = {
        id: id("txn"),
        card_id: card.id,
        user_id: card.user_id,
        status: declined || overBalance ? "declined" : sub === "test_charge" ? "cleared" : "authorized",
        amount,
        merchant,
        mcc,
        decline_reason: declined ? String(b.decline_reason ?? "insufficient_funds") : overBalance ? "insufficient_funds" : null,
        created_at: now(),
      };
      const outbox: Outbox = [];
      await write((db) => {
        const c = db.mockIssuer.cards[card.id];
        db.mockIssuer.transactions[txn.id] = txn;
        if (txn.status === "declined") {
          outbox.push({ type: "transaction.declined", data: txnEvent(txn, c, "DECLINED") });
          return;
        }
        c.balance_cents -= amount;
        outbox.push({ type: "transaction.authorized", data: txnEvent(txn, c, "PENDING") });
        if (txn.status === "cleared") outbox.push({ type: "transaction.cleared", data: txnEvent(txn, c, "SETTLED") });
        if (c.type === "single_use") {
          db.mockIssuer.walletCents += c.balance_cents; // what the merchant did not take is released
          c.balance_cents = 0;
          c.status = "closed";
          c.closed_reason = "used";
          outbox.push({ type: "card.closed", data: publicCard(c) });
        }
      });
      const fresh = read().mockIssuer.cards[card.id];
      return {
        status: 201,
        body: { object: "test_transaction", id: txn.id, card_id: card.id, amount_cents: amount, merchant, mcc, status: txn.status, ...(txn.decline_reason ? { decline_reason: txn.decline_reason } : {}), simulated: true, events: outbox.map((e) => e.type), card: publicCard(fresh) },
        after: () => deliver(outbox),
      };
    }
  }

  // ---- transactions ----
  if (route === "GET /transactions") {
    const cardFilter = query.get("card_id");
    const data = Object.values(read().mockIssuer.transactions)
      .filter((t) => !cardFilter || t.card_id === cardFilter)
      .sort((a, b2) => b2.created_at.localeCompare(a.created_at))
      .map(publicTxn);
    return { status: 200, body: { object: "list", data, cursor: null, has_more: false } };
  }
  if (method === "GET" && path[0] === "transactions" && path[1]) {
    const t = read().mockIssuer.transactions[path[1]];
    if (!t) throw new MockHttpError(404, "transaction_not_found", "No such transaction");
    return { status: 200, body: publicTxn(t) };
  }

  throw new MockHttpError(404, "not_found", `Mock Agentcard does not implement ${route}`);
}

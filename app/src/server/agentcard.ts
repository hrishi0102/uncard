import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

/**
 * Agentcard Issuing API v2 client (https://docs.agentcard.com/issuing/quickstart).
 * The exact same client talks to the real sandbox (CARD_ISSUER=agentcard) or to our
 * local mock at /api/mock-agentcard, which implements the same endpoints and webhooks.
 */

export class AgentcardError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export type AgentcardCard = {
  object: "card";
  id: string;
  status: string;
  type: string;
  spend_limit_cents: number;
  balance_cents: number;
  last4: string;
  expiry: string;
  user_id: string | null;
  closed_reason?: string;
  created_at: string;
};

export type AgentcardCredentials = {
  object: "card_credentials";
  id: string;
  number: string;
  exp_month: string;
  exp_year: string;
  cvc: string;
  last4: string;
  cardholder_name?: string;
  billing_address?: string;
};

export type AgentcardTransaction = {
  object: "transaction";
  id: string;
  status: "pending" | "authorized" | "cleared" | "declined" | "voided" | "refunded";
  amount: number | null;
  merchant: string | null;
  mcc: string | null;
  decline_reason: string | null;
  card_id: string | null;
  user_id: string | null;
  last4: string | null;
  created_at: string;
};

type G = typeof globalThis & { __acToken?: { token: string; exp: number; base: string } };
const g = globalThis as G;

const base = () => config.cardIssuer.apiUrl.replace(/\/$/, "");

async function token(): Promise<string> {
  const now = Date.now() / 1000;
  if (g.__acToken && g.__acToken.base === base() && g.__acToken.exp > now + 60) return g.__acToken.token;
  if (!config.cardIssuer.clientId || !config.cardIssuer.clientSecret) {
    throw new AgentcardError(401, "missing_credentials", "Set AGENTCARD_CLIENT_ID and AGENTCARD_CLIENT_SECRET");
  }
  const res = await fetch(`${base()}/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.cardIssuer.clientId,
      client_secret: config.cardIssuer.clientSecret,
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new AgentcardError(res.status, body.error ?? "token_failed", "Could not get an Agentcard access token", body);
  }
  g.__acToken = { token: body.access_token, exp: now + (body.expires_in ?? 3600), base: base() };
  return body.access_token;
}

async function call<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${base()}/api/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string } })?.error;
    throw new AgentcardError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? text.slice(0, 200), parsed);
  }
  return parsed as T;
}

export const agentcard = {
  // ---- one-time user setup (sandbox: code is always 111111, KYC can be simulated) ----
  connectStart: (email: string) => call<{ id: string }>("POST", "/connect/start", { email }),
  connectVerify: (connectId: string, code: string) =>
    call<{ user: { id: string; email?: string } }>("POST", "/connect/verify", { connect_id: connectId, code }),
  consent: (userId: string) => call("POST", "/connect/consent", { user_id: userId }),
  kycSimulate: (userId: string, outcome: "approved" | "rejected" = "approved") =>
    call("POST", "/kyc/simulate", { user_id: userId, outcome }),
  companyWallet: () => call<{ available_cents: number; balance_cents: number }>("GET", "/company_wallet"),
  testFundCompanyWallet: (amountCents: number) =>
    call<{ available_cents: number }>("POST", "/company_wallet/test_fund", { amount_cents: amountCents }),
  createWebhookEndpoint: (url: string, events: string[]) =>
    call<{ id: string; secret: string }>("POST", "/webhook_endpoints", { url, enabled_events: events }),

  // ---- per purchase ----
  /** Single-use card for the exact amount. Idempotency-Key = intent id, so a retry never buys two cards. */
  async createCard(userId: string, amountCents: number, idempotencyKey: string): Promise<AgentcardCard> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await call<AgentcardCard | { object: "card_funding"; retry_after_seconds: number }>(
        "POST",
        "/cards",
        { user_id: userId, amount_cents: amountCents, type: "single_use" },
        { "Idempotency-Key": idempotencyKey },
      );
      if (res.object === "card") return res;
      // 202 funding_in_progress: wait and collect the same card with the same key
      await new Promise((r) => setTimeout(r, Math.min(15, res.retry_after_seconds ?? 3) * 1000));
    }
    throw new AgentcardError(504, "funding_timeout", "Card funding did not finish in time");
  },
  getCard: (cardId: string) => call<AgentcardCard>("GET", `/cards/${cardId}`),
  /** Read at checkout time only. Never log the result. */
  credentials: (cardId: string) => call<AgentcardCredentials>("GET", `/cards/${cardId}/credentials`),
  closeCard: (cardId: string) => call<AgentcardCard>("POST", `/cards/${cardId}/close`),
  listTransactions: (cardId: string) =>
    call<{ data: AgentcardTransaction[] }>("GET", `/transactions?card_id=${encodeURIComponent(cardId)}`),

  // ---- sandbox-only charge simulation (what our mock shop's "card network" uses) ----
  testCharge: (cardId: string, p: { amount_cents: number; merchant: string; mcc?: string }) =>
    call<{ id: string; status: string; amount_cents: number; events: string[] }>(
      "POST",
      `/cards/${cardId}/test_charge`,
      p,
    ),
  testAuthorization: (
    cardId: string,
    p: { amount_cents: number; merchant: string; mcc?: string; outcome: "approved" | "declined"; decline_reason?: string },
  ) =>
    call<{ id: string; status: string; decline_reason?: string; events: string[] }>(
      "POST",
      `/cards/${cardId}/test_authorization`,
      p,
    ),
};

/** AgentCard-Signature: t=<unix>,v1=<hex hmac_sha256(secret, `${t}.${rawBody}`)> */
export function verifyWebhookSignature(rawBody: string, header: string | null, secret: string, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signWebhook(rawBody: string, secret: string) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

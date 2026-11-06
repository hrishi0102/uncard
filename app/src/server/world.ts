import "server-only";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config";

/**
 * World ID Agent Pass (World IdP, an OpenID Connect issuer) used as a human checkpoint.
 * Flow: RFC 8628 Device Authorization Grant, which World documents for headless agents:
 * https://auth.world.org/docs/guides/step-up#human-checkpoints
 *
 *  1. Backend starts a device authorization (confidential client, scope=openid, essential acr).
 *  2. The human opens verification_uri_complete in World App and approves (fresh auth is always required).
 *  3. Backend polls the token endpoint, then validates the ID token: signature (JWKS), iss, aud, exp,
 *     auth_time freshness and acr. device_code never leaves the server or reaches the agent.
 *
 * WORLD_MODE=mock points the same code at our local IdP (/api/mock-world), which signs real RS256 tokens.
 */

type Discovery = {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

type G = typeof globalThis & {
  __worldDisc?: { issuer: string; doc: Discovery };
  __worldJwks?: { uri: string; set: ReturnType<typeof createRemoteJWKSet> };
};
const g = globalThis as G;

export async function discovery(): Promise<Discovery> {
  if (g.__worldDisc?.issuer === config.world.issuer) return g.__worldDisc.doc;
  const res = await fetch(`${config.world.issuer}/.well-known/openid-configuration`, { cache: "no-store" });
  if (!res.ok) throw new Error(`World discovery failed: HTTP ${res.status}`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer !== config.world.issuer) throw new Error(`World issuer mismatch: ${doc.issuer}`);
  g.__worldDisc = { issuer: config.world.issuer, doc };
  return doc;
}

function clientAuth(form: URLSearchParams): Record<string, string> {
  const method = process.env.WORLD_CLIENT_AUTH ?? "client_secret_basic";
  if (method === "client_secret_post" || config.world.mode === "mock") {
    form.set("client_id", config.world.clientId);
    form.set("client_secret", config.world.clientSecret);
    return {};
  }
  // client_secret_basic (portal default)
  const basic = Buffer.from(
    `${encodeURIComponent(config.world.clientId)}:${encodeURIComponent(config.world.clientSecret)}`,
  ).toString("base64");
  form.set("client_id", config.world.clientId);
  return { Authorization: `Basic ${basic}` };
}

export function isWorldConfigured() {
  return Boolean(config.world.clientId && config.world.clientSecret);
}

export type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

export async function startDeviceAuthorization(): Promise<DeviceStart> {
  if (!isWorldConfigured()) throw new Error("World ID is not configured (WORLD_CLIENT_ID / WORLD_CLIENT_SECRET)");
  const d = await discovery();
  const form = new URLSearchParams({ scope: "openid" });
  // Require a verified human: any accepted class is enough (World checks, we re-check acr below).
  form.set("claims", JSON.stringify({ id_token: { acr: { essential: true, values: config.world.acceptedAcr } } }));
  const headers = { "Content-Type": "application/x-www-form-urlencoded", ...clientAuth(form) };
  const res = await fetch(d.device_authorization_endpoint, { method: "POST", headers, body: form, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as DeviceStart & { error?: string; error_description?: string };
  if (!res.ok || !body.device_code) {
    throw new Error(`World device authorization failed: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
  }
  return body;
}

export type PollResult =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "approved"; idToken: string }
  | { state: "denied"; error: string }
  | { state: "expired"; error: string }
  | { state: "error"; error: string };

export async function pollDeviceToken(deviceCode: string): Promise<PollResult> {
  const d = await discovery();
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
  });
  const headers = { "Content-Type": "application/x-www-form-urlencoded", ...clientAuth(form) };
  let res: Response;
  try {
    res = await fetch(d.token_endpoint, { method: "POST", headers, body: form, cache: "no-store" });
  } catch (e) {
    return { state: "pending" }; // connection timeout: back off and poll again
  }
  if (res.status === 503) return { state: "error", error: "world_unavailable" }; // never treat as approval
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (res.ok && body.id_token) return { state: "approved", idToken: body.id_token };
  switch (body.error) {
    case "authorization_pending":
      return { state: "pending" };
    case "slow_down":
      return { state: "slow_down" };
    case "access_denied":
      return { state: "denied", error: "access_denied" };
    case "expired_token":
      return { state: "expired", error: "expired_token" };
    default:
      return { state: "error", error: body.error ?? `http_${res.status}` };
  }
}

export type VerifiedHuman = { iss: string; sub: string; acr?: string; amr?: string[]; authTime: number };

/** Validate a World ID token for an attempt that started at `attemptStartedAt` (unix seconds). */
export async function validateIdToken(idToken: string, attemptStartedAt: number): Promise<VerifiedHuman> {
  const d = await discovery();
  if (!g.__worldJwks || g.__worldJwks.uri !== d.jwks_uri) {
    g.__worldJwks = { uri: d.jwks_uri, set: createRemoteJWKSet(new URL(d.jwks_uri)) };
  }
  const { payload } = await jwtVerify(idToken, g.__worldJwks.set, {
    issuer: config.world.issuer,
    audience: config.world.clientId,
    algorithms: ["RS256"],
    clockTolerance: 60,
  });
  const authTime = Number(payload.auth_time);
  const now = Math.floor(Date.now() / 1000);
  const tol = config.world.clockToleranceSeconds;
  if (!authTime) throw new Error("ID token has no auth_time");
  // Fresh: the authentication must belong to this attempt (device flow always re-authenticates).
  if (authTime < attemptStartedAt - tol) throw new Error("World authentication is older than this approval");
  if (authTime > now + tol) throw new Error("World auth_time is in the future");
  const acr = typeof payload.acr === "string" ? payload.acr : undefined;
  if (!acr || !config.world.acceptedAcr.includes(acr)) {
    throw new Error(`World ID assurance not accepted (acr=${acr ?? "none"})`);
  }
  if (!payload.sub || !payload.iss) throw new Error("ID token missing sub or iss");
  return {
    iss: payload.iss,
    sub: payload.sub,
    acr,
    amr: Array.isArray(payload.amr) ? (payload.amr as string[]) : undefined,
    authTime,
  };
}

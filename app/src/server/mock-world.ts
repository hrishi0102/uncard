import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { config } from "./config";
import { read, write } from "./store";

/**
 * Local stand-in for the World IdP sandbox (OIDC discovery, JWKS, device authorization, token).
 * It signs real RS256 ID tokens, so our backend validates them with exactly the same code it uses
 * for https://sandbox.auth.world.org. The "World App" approval screen is /mock-world/device.
 */

const issuer = () => `${config.appUrl}/api/mock-world`;
const ACR_ORB = "https://world.org/oidc/acr/orb";

async function keys() {
  const db = read();
  if (db.mockWorld.privateJwk && db.mockWorld.publicJwk) {
    return { priv: db.mockWorld.privateJwk as unknown as JWK, pub: db.mockWorld.publicJwk as unknown as JWK };
  }
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = `mock-${randomBytes(4).toString("hex")}`;
  const priv = { ...(await exportJWK(privateKey)), kid, alg: "RS256", use: "sig" };
  const pub = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  await write((d) => {
    d.mockWorld.privateJwk = priv as Record<string, unknown>;
    d.mockWorld.publicJwk = pub as Record<string, unknown>;
  });
  return { priv: priv as JWK, pub: pub as JWK };
}

export function discoveryDoc() {
  const iss = issuer();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/api/v1/authorize`,
    device_authorization_endpoint: `${iss}/api/v1/device_authorization`,
    token_endpoint: `${iss}/api/v1/token`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
    response_types_supported: ["code"],
    subject_types_supported: ["pairwise"],
    id_token_signing_alg_values_supported: ["RS256"],
    acr_values_supported: [ACR_ORB, "https://world.org/oidc/acr/orb-face"],
    scopes_supported: ["openid"],
  };
}

export async function jwks() {
  const { pub } = await keys();
  return { keys: [pub] };
}

function checkClient(form: URLSearchParams) {
  return form.get("client_id") === "mock_world_client" && form.get("client_secret") === "mock_world_secret";
}

export async function deviceAuthorization(form: URLSearchParams) {
  if (!checkClient(form)) return { status: 401, body: { error: "invalid_client" } };
  if (form.get("scope") !== "openid") return { status: 400, body: { error: "invalid_scope" } };
  const deviceCode = randomBytes(24).toString("base64url");
  const userCode = `${randomInt(1000, 10000)}-${randomInt(1000, 10000)}`;
  const now = Math.floor(Date.now() / 1000);
  await write((d) => {
    d.mockWorld.deviceCodes[deviceCode] = {
      userCode,
      clientId: "mock_world_client",
      status: "pending",
      createdAt: now,
      expiresAt: now + 20 * 60,
    };
  });
  return {
    status: 200,
    body: {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${config.appUrl}/mock-world/device`,
      verification_uri_complete: `${config.appUrl}/mock-world/device?user_code=${userCode}`,
      expires_in: 20 * 60,
      interval: 2,
    },
  };
}

export async function token(form: URLSearchParams) {
  if (!checkClient(form)) return { status: 401, body: { error: "invalid_client" } };
  if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:device_code") {
    return { status: 400, body: { error: "unsupported_grant_type" } };
  }
  const code = form.get("device_code") ?? "";
  const entry = read().mockWorld.deviceCodes[code];
  if (!entry) return { status: 400, body: { error: "invalid_grant" } };
  const now = Math.floor(Date.now() / 1000);
  if (now > entry.expiresAt) return { status: 400, body: { error: "expired_token" } };
  if (entry.status === "pending") return { status: 400, body: { error: "authorization_pending" } };
  if (entry.status === "denied") return { status: 400, body: { error: "access_denied" } };

  // approved: redeem once
  await write((d) => {
    delete d.mockWorld.deviceCodes[code];
  });
  const { priv } = await keys();
  const key = await importJWK(priv, "RS256");
  const idToken = await new SignJWT({ auth_time: entry.authTime ?? now, acr: entry.acr ?? ACR_ORB, amr: ["world_id_proof"] })
    .setProtectedHeader({ alg: "RS256", kid: priv.kid })
    .setIssuer(issuer())
    .setAudience(entry.clientId)
    .setSubject(entry.sub ?? "unknown")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(randomBytes(8).toString("hex"))
    .sign(key);
  return {
    status: 200,
    body: { id_token: idToken, access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300 },
  };
}

/** Personas on the simulated World App screen: the account owner, or someone else (wrong-account test). */
export const PERSONAS = {
  owner: "Account owner (Orb verified)",
  stranger: "A different person (Orb verified)",
  unverified: "Unverified World account",
} as const;

export async function decide(userCode: string, decision: "approve" | "deny", persona: keyof typeof PERSONAS) {
  const entry = Object.entries(read().mockWorld.deviceCodes).find(([, v]) => v.userCode === userCode);
  if (!entry) return { ok: false, error: "Unknown or expired code" };
  const [code] = entry;
  // pairwise subject: stable per persona and client, like World's sector-scoped sub
  const sub = `mock_${createHash("sha256").update(`${persona}:mock_world_client`).digest("hex").slice(0, 32)}`;
  await write((d) => {
    const e = d.mockWorld.deviceCodes[code];
    if (!e) return;
    e.status = decision === "approve" ? "approved" : "denied";
    e.sub = sub;
    e.authTime = Math.floor(Date.now() / 1000);
    e.acr = persona === "unverified" ? "none" : ACR_ORB;
  });
  return { ok: true };
}

export function lookup(userCode: string) {
  const entry = Object.values(read().mockWorld.deviceCodes).find((v) => v.userCode === userCode);
  if (!entry) return null;
  return { status: entry.status, expiresAt: entry.expiresAt, requester: "AnyCheckout" };
}

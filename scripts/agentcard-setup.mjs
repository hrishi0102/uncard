#!/usr/bin/env node
// One-time Agentcard SANDBOX setup for the demo user (no real money, sandbox needs no plan).
//
// Prereqs:
//   1. npx agent-cards signin            (needs an Agentcard account: sign-ups are invite-only)
//   2. npx agent-cards credentials --mode sandbox   -> AGENTCARD_CLIENT_ID / AGENTCARD_CLIENT_SECRET
//   3. In the Agentcard dashboard: Settings -> Issuing -> switch to company-funded (owner only)
//
// Run:
//   AGENTCARD_CLIENT_ID=... AGENTCARD_CLIENT_SECRET=... DEMO_EMAIL=you@example.com \
//   PUBLIC_URL=https://<your-tunnel>.ngrok.app  node scripts/agentcard-setup.mjs
//
// It connects the user (sandbox code 111111), records consent, simulates KYC approval,
// adds test money to the company wallet, and (if PUBLIC_URL is set) registers our webhook.
// Without a webhook the app still works: it polls /transactions as a fallback.

const API = (process.env.AGENTCARD_API_URL ?? "https://api.agentcard.sh").replace(/\/$/, "");
const { AGENTCARD_CLIENT_ID: id, AGENTCARD_CLIENT_SECRET: secret, DEMO_EMAIL: email, PUBLIC_URL: publicUrl } = process.env;
if (!id || !secret || !email) {
  console.error("Set AGENTCARD_CLIENT_ID, AGENTCARD_CLIENT_SECRET and DEMO_EMAIL");
  process.exit(1);
}

async function token() {
  const res = await fetch(`${API}/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  const b = await res.json();
  if (!res.ok) throw new Error(`token: ${JSON.stringify(b)}`);
  return b.access_token;
}

const t = await token();
async function call(method, path, body) {
  const res = await fetch(`${API}/api/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(b)}`);
  return b;
}

const who = await call("GET", "");
console.log("credential:", JSON.stringify(who));

const attempt = await call("POST", "/connect/start", { email });
const conn = await call("POST", "/connect/verify", { connect_id: attempt.id, code: "111111" });
const userId = conn.user.id;
await call("POST", "/connect/consent", { user_id: userId });
await call("POST", "/kyc/simulate", { user_id: userId, outcome: "approved" }).catch((e) => console.warn("kyc:", e.message));
const wallet = await call("POST", "/company_wallet/test_fund", { amount_cents: 100000 });
console.log("company wallet available:", wallet.available_cents);

let webhookSecret = "";
if (publicUrl) {
  const hook = await call("POST", "/webhook_endpoints", {
    url: `${publicUrl.replace(/\/$/, "")}/api/webhooks/agentcard`,
    enabled_events: ["card.*", "transaction.*"],
  });
  webhookSecret = hook.secret;
}

console.log("\nAdd these to app/.env.local:\n");
console.log("CARD_ISSUER=agentcard");
console.log(`AGENTCARD_CLIENT_ID=${id}`);
console.log("AGENTCARD_CLIENT_SECRET=<same as above>");
console.log(`AGENTCARD_USER_ID=${userId}`);
console.log(`AGENTCARD_WEBHOOK_SECRET=${webhookSecret || "<create a webhook endpoint, or leave empty to rely on polling>"}`);

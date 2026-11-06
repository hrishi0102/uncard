#!/usr/bin/env node
// A scripted stand-in for a real AI agent: it talks to AnyCheckout only through MCP,
// then "types" the card into a mock shop's checkout, exactly like a browser agent would.
//
//   node scripts/demo-agent.mjs                # run every scenario
//   node scripts/demo-agent.mjs partial        # one scenario: partial | decline | approval | deny | abandon
//
// Env: APP_URL (default http://localhost:3100), AGENT_KEY (default the local demo key)

const APP = (process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, "");
const KEY = process.env.AGENT_KEY ?? "ak_demo_local_only_change_me";
let rpcId = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function mcp(method, params) {
  const res = await fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function tool(name, args = {}) {
  const r = await mcp("tools/call", { name, arguments: args });
  const data = r.structuredContent ?? JSON.parse(r.content[0].text);
  return { data, isError: Boolean(r.isError) };
}

async function checkout(shop, items, card) {
  const res = await fetch(`${APP}/api/shop/${shop}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items,
      card: { number: card.number, exp: `${card.exp_month}/${card.exp_year.slice(-2)}`, cvc: card.cvc, name: card.name_on_card },
    }),
  });
  return res.json();
}

async function waitFor(intentId, done, label = "status") {
  for (let i = 0; i < 40; i++) {
    const { data } = await tool("anycheckout_status", { intent_id: intentId });
    if (done.includes(data.status)) return data;
    await sleep(1500);
  }
  throw new Error(`${label}: timed out waiting for ${done.join("/")}`);
}

const money = (c) => `$${(c / 100).toFixed(2)}`;
const mask = (n) => `•••• ${String(n).slice(-4)}`;

// ---------------------------------------------------------------------------

async function partial() {
  log("\n=== 1. Bandra Gadgets: power bank + cable, shop waives shipping at payment ===");
  const items = [{ sku: "powerbank", qty: 1 }, { sku: "cable", qty: 1 }];
  const total = 3450 + 1299 + 699;
  const { data: pay } = await tool("anycheckout_pay", {
    merchant_name: "Bandra Gadgets",
    merchant_url: "https://bandra-gadgets.anycheckout.dev/checkout",
    amount: total / 100,
    description: "20,000 mAh power bank + braided USB-C cable",
  });
  log(`agent: anycheckout_pay ${money(total)} -> ${pay.status}, card ${mask(pay.card?.number)}`);
  if (pay.status !== "card_issued") throw new Error(JSON.stringify(pay));
  const order = await checkout("bandra-gadgets", items, pay.card);
  log(`shop:  ${order.ok ? `order ${order.orderId}, charged ${money(order.chargedCents)}` : order.error}`);
  const final = await waitFor(pay.intent_id, ["settled", "refunded"]);
  log(`vault: ${final.status}: charged $${final.charged}, returned $${final.refunded_to_user}  tx ${final.settlement_tx}`);
}

async function decline() {
  log("\n=== 2. Fortress Electronics refuses virtual cards, then merchant memory kicks in ===");
  const items = [{ sku: "mouse", qty: 1 }];
  const total = 2900 + 500;
  const { data: pay } = await tool("anycheckout_pay", {
    merchant_name: "Fortress Electronics",
    merchant_url: "https://fortress-electronics.anycheckout.dev/checkout",
    amount: total / 100,
    description: "Wireless mouse",
  });
  log(`agent: anycheckout_pay ${money(total)} -> ${pay.status}`);
  if (pay.status === "card_issued") {
    const order = await checkout("fortress-electronics", items, pay.card);
    log(`shop:  ${order.ok ? "approved?!" : order.error}`);
    const final = await waitFor(pay.intent_id, ["refunded", "settled"]);
    log(`vault: ${final.status}: returned $${final.refunded_to_user} (${final.decline_reason ?? ""})`);
  }
  const { data: again } = await tool("anycheckout_pay", {
    merchant_name: "Fortress Electronics",
    merchant_url: "https://fortress-electronics.anycheckout.dev/checkout",
    amount: total / 100,
    description: "Wireless mouse (second try)",
  });
  log(`agent: second try -> ${again.status} ${JSON.stringify(again.reason ?? "")}`);
  const { data: check } = await tool("anycheckout_check_merchant", { merchant: "fortress-electronics.anycheckout.dev" });
  log(`memory: ${check.verdict} (declined ${check.declined}x, ${check.lastDeclineReason})`);
}

async function approveFlow(decision) {
  log(`\n=== ${decision === "approve" ? "3" : "4"}. Headphones above the $100 limit -> World ID human check (${decision}) ===`);
  const items = [{ sku: "headphones", qty: 1 }];
  const total = 17900 + 699;
  const { data: pay } = await tool("anycheckout_pay", {
    merchant_name: "Bandra Gadgets",
    merchant_url: "https://bandra-gadgets.anycheckout.dev/checkout",
    amount: total / 100,
    description: "Noise-cancelling headphones",
  });
  log(`agent: anycheckout_pay ${money(total)} -> ${pay.status} (${(pay.reason ?? []).join(", ")})`);
  if (pay.status !== "needs_approval") throw new Error(JSON.stringify(pay));
  log(`agent: "Please approve here: ${pay.approval_url}"`);

  // --- the human (simulated): open the approval page, verify with World ID, decide ---
  const start = await (await fetch(`${APP}/api/approvals/${pay.intent_id}/start`, { method: "POST" })).json();
  log(`human: World ID code ${start.userCode}`);
  if (decision === "approve") {
    await fetch(`${APP}/api/mock-world/device/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: start.userCode, decision: "approve", persona: "owner" }),
    });
    for (let i = 0; i < 20; i++) {
      const v = await (await fetch(`${APP}/api/approvals/${pay.intent_id}`)).json();
      if (v.intent.approval?.status === "verified") break;
      await sleep(1000);
    }
    log("human: World ID verified, tapping Approve");
  }
  const d = await (
    await fetch(`${APP}/api/approvals/${pay.intent_id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    })
  ).json();
  log(`human: decision -> ${d.status ?? d.error}`);

  const { data: card } = await tool("anycheckout_get_card", { intent_id: pay.intent_id });
  if (decision === "deny") {
    log(`agent: anycheckout_get_card -> ${card.status} (protected action did not happen)`);
    return;
  }
  log(`agent: anycheckout_get_card -> ${card.status}, card ${mask(card.card?.number)}`);
  const order = await checkout("bandra-gadgets", items, card.card);
  log(`shop:  ${order.ok ? `order ${order.orderId}, charged ${money(order.chargedCents)}` : order.error}`);
  const final = await waitFor(pay.intent_id, ["settled", "refunded"]);
  log(`vault: ${final.status}: charged $${final.charged}, returned $${final.refunded_to_user}`);
}

async function abandon() {
  log("\n=== 5. Agent abandons checkout -> card closed, full refund ===");
  const { data: pay } = await tool("anycheckout_pay", {
    merchant_name: "Chai & Co. Mumbai",
    merchant_url: "https://chai-co.anycheckout.dev/checkout",
    amount: 18.99,
    description: "Masala chai tin",
  });
  log(`agent: anycheckout_pay $18.99 -> ${pay.status}`);
  await fetch(`${APP}/api/intents/${pay.intent_id}/abandon`, { method: "POST" });
  const final = await waitFor(pay.intent_id, ["refunded", "settled"]);
  log(`vault: ${final.status}: returned $${final.refunded_to_user}`);
}

// ---------------------------------------------------------------------------

const init = await mcp("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "anycheckout-demo-agent", version: "0.1.0" },
});
log(`connected to ${init.serverInfo.name} (MCP ${init.protocolVersion})`);
const { tools } = await mcp("tools/list", {});
log(`tools: ${tools.map((t) => t.name).join(", ")}`);
const { data: bal } = await tool("anycheckout_balance");
log(`balance: $${bal.vault_balance} in vault, $${bal.weekly_allowance_left} left this week, $${bal.per_purchase_limit} per purchase`);

const which = process.argv[2];
const scenarios = { partial, decline, approval: () => approveFlow("approve"), deny: () => approveFlow("deny"), abandon };
for (const [name, fn] of Object.entries(scenarios)) {
  if (!which || which === name) await fn();
}
const { data: after } = await tool("anycheckout_balance");
log(`\nbalance now: $${after.vault_balance} in vault, $${after.weekly_allowance_left} left this week`);

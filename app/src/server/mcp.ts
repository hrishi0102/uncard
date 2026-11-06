import "server-only";
import { z } from "zod";
import * as chain from "./chain";
import { config } from "./config";
import { agentView, createIntent, ensureBackgroundLoop, getCardForAgent, getIntent, pollApproval } from "./intents";
import { domainFrom, merchantVerdict } from "./merchants";
import type { User } from "./types";
import { agentLabel, ensureDemoUser, userByAgentKey } from "./users";

/**
 * AnyCheckout MCP server (Streamable HTTP, stateless JSON responses).
 * Add it to any agent:  POST {APP_URL}/api/mcp  with  Authorization: Bearer <agent key>
 */

const SERVER_INFO = { name: "anycheckout", title: "AnyCheckout", version: "0.1.0" };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `AnyCheckout lets you pay on any website that takes cards, while your human pays in crypto.
Use it only at the final checkout step, once the cart total (with tax and shipping) is final.
1) Call anycheckout_pay with the merchant and the exact final total. You get a single-use card for exactly that amount.
2) Type the card into the merchant's payment form and submit.
3) Call anycheckout_status until it says settled or refunded. Only the charged amount is paid; the rest goes back automatically.
If anycheckout_pay returns needs_approval, send the approval_url to your human. Only they can approve it with World ID.
Never invent card numbers, never reuse a card for another purchase, and never show the card number to anyone except the payment form.`;

const payArgs = z.object({
  merchant_name: z.string().min(1).max(120),
  merchant_url: z.string().max(500).optional(),
  amount: z.coerce.number().positive().max(10_000),
  currency: z.string().default("USD"),
  description: z.string().min(1).max(500),
  idempotency_key: z.string().max(120).optional(),
  proceed_if_merchant_declined_before: z.boolean().optional(),
});

const TOOLS = [
  {
    name: "anycheckout_pay",
    title: "Pay at checkout",
    description:
      "Get a single-use virtual card for the exact final checkout total. Funds are locked in the user's USDC vault on Arc and only the amount the merchant actually charges is paid. Returns the card details (status card_issued), or an approval_url when a human must approve with World ID (status needs_approval), or a rejection with the reason.",
    inputSchema: {
      type: "object",
      properties: {
        merchant_name: { type: "string", description: "Store name as shown on the site" },
        merchant_url: { type: "string", description: "Checkout page URL or store domain" },
        amount: { type: "number", description: "Final total in USD including tax and shipping, e.g. 54.99" },
        currency: { type: "string", enum: ["USD"], default: "USD" },
        description: { type: "string", description: "What is being bought, e.g. '2x Masala chai tins'" },
        idempotency_key: { type: "string", description: "Optional. Same key returns the same checkout instead of a new card." },
        proceed_if_merchant_declined_before: {
          type: "boolean",
          description: "Set true only if your human insists on a merchant AnyCheckout remembers declining these cards.",
        },
      },
      required: ["merchant_name", "amount", "description"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "anycheckout_get_card",
    title: "Read the card for a checkout",
    description: "Read the card number, expiry and CVC for an approved checkout. Use right before typing it into the payment form.",
    inputSchema: { type: "object", properties: { intent_id: { type: "string" } }, required: ["intent_id"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "anycheckout_status",
    title: "Checkout status",
    description: "Status of a checkout: needs_approval, card_issued, charged, settled, declined, refunded, denied or rejected, with amounts and the Arc settlement transaction.",
    inputSchema: { type: "object", properties: { intent_id: { type: "string" } }, required: ["intent_id"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "anycheckout_balance",
    title: "Spending power",
    description: "The user's vault balance, what the agent may still spend this week without asking, and the per-purchase limit.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "anycheckout_check_merchant",
    title: "Check a merchant",
    description: "Ask whether a store is known to accept or decline AnyCheckout's single-use virtual cards, before you build a cart there.",
    inputSchema: {
      type: "object",
      properties: { merchant: { type: "string", description: "Store domain, URL or name" } },
      required: ["merchant"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const ok = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id: id ?? null, result });
const fail = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});
const toolResult = (data: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
  ...(isError ? { isError: true } : {}),
});

async function callTool(user: User, label: string, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "anycheckout_pay": {
      const parsed = payArgs.safeParse(args);
      if (!parsed.success) return toolResult({ error: "invalid_arguments", issues: parsed.error.issues }, true);
      const a = parsed.data;
      if (a.currency.toUpperCase() !== "USD") return toolResult({ error: "Only USD checkouts are supported in this version" }, true);
      const amountCents = Math.round(a.amount * 100);
      if (amountCents < 100) return toolResult({ error: "Minimum purchase is $1.00" }, true);
      const intent = await createIntent(user, label, {
        merchantName: a.merchant_name,
        merchantUrl: a.merchant_url,
        amountCents,
        description: a.description,
        idempotencyKey: a.idempotency_key,
        proceedIfMerchantDeclinedBefore: a.proceed_if_merchant_declined_before,
      });
      const view = agentView(intent);
      if (intent.status === "card_issued") {
        const card = await getCardForAgent(user, intent.id);
        return toolResult({
          ...view,
          card,
          next_step:
            "Type this card into the merchant's payment form now and submit. It is single-use and only covers this checkout. Then call anycheckout_status with intent_id.",
        });
      }
      return toolResult(view, ["rejected", "failed"].includes(intent.status));
    }
    case "anycheckout_get_card": {
      const id = String(args.intent_id ?? "");
      const intent = getIntent(id);
      if (!intent || intent.userId !== user.id) return toolResult({ error: "No such checkout" }, true);
      if (intent.status === "needs_approval") await pollApproval(id);
      const fresh = getIntent(id)!;
      if (fresh.status !== "card_issued") return toolResult(agentView(fresh), fresh.status !== "needs_approval");
      return toolResult({ ...agentView(fresh), card: await getCardForAgent(user, id) });
    }
    case "anycheckout_status": {
      const id = String(args.intent_id ?? "");
      const intent = getIntent(id);
      if (!intent || intent.userId !== user.id) return toolResult({ error: "No such checkout" }, true);
      if (intent.status === "needs_approval") await pollApproval(id);
      return toolResult(agentView(getIntent(id)!));
    }
    case "anycheckout_balance": {
      const acct = await chain.readAccount(user.wallet);
      return toolResult({
        vault_balance: (acct.availableCents / 100).toFixed(2),
        locked_in_open_checkouts: (acct.lockedCents / 100).toFixed(2),
        weekly_allowance_left: (acct.remainingThisWindowCents / 100).toFixed(2),
        per_purchase_limit: (acct.perPurchaseLimitCents / 100).toFixed(2),
        agent_enabled: acct.agentEnabled,
        currency: "USD (USDC on Arc)",
        note: "Purchases above the limits need a World ID approval from your human. Top ups: " + `${config.appUrl}/dashboard`,
      });
    }
    case "anycheckout_check_merchant": {
      const domain = domainFrom(String(args.merchant ?? ""));
      return toolResult({ merchant: domain, ...merchantVerdict(domain) });
    }
    default:
      return null;
  }
}

export async function handleMcpMessage(
  msg: JsonRpcRequest,
  authKey: string | null,
): Promise<ReturnType<typeof ok> | ReturnType<typeof fail> | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return ok(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: TOOLS });
    case "tools/call": {
      await ensureDemoUser();
      ensureBackgroundLoop();
      const user = userByAgentKey(authKey);
      if (!user) return ok(msg.id, toolResult({ error: "Unauthorized: send Authorization: Bearer <agent key>" }, true));
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const res = await callTool(user, agentLabel(user, authKey!), name, args);
        if (!res) return fail(msg.id, -32602, `Unknown tool: ${name}`);
        return ok(msg.id, res);
      } catch (e) {
        console.error("[mcp] tool error", name, e);
        return ok(msg.id, toolResult({ error: (e as Error).message }, true));
      }
    }
    default:
      return isNotification ? null : fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

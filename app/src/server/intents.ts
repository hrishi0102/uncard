import "server-only";
import { randomBytes } from "node:crypto";
import { BaseError, ContractFunctionRevertedError, keccak256, toBytes } from "viem";
import { agentcard, type AgentcardTransaction } from "./agentcard";
import * as chain from "./chain";
import { config } from "./config";
import { domainFrom, merchantVerdict, recordMerchant } from "./merchants";
import { decideSettlement } from "./settlement-logic";
import { read, write } from "./store";
import type { Hex, Intent, User } from "./types";
import { pollDeviceToken, startDeviceAuthorization, validateIdToken } from "./world";

/**
 * Intent lifecycle:
 *   created -> (policy ok) -> processing -> card_issued -> charged|declined -> settled|refunded
 *           -> (over limit) -> needs_approval -> World ID verified + human confirms -> processing -> ...
 *                                             -> denied (cancel, expiry, wrong World ID, deny)
 *           -> rejected (balance, kill switch, merchant known to refuse virtual cards)
 */

const nowIso = () => new Date().toISOString();
const nowSec = () => Math.floor(Date.now() / 1000);
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const APPROVAL_FRESHNESS_SECONDS = 10 * 60;

function push(i: Intent, type: string, detail: string, tx?: Hex) {
  i.timeline.push({ at: nowIso(), type, detail, ...(tx ? { tx } : {}) });
  i.updatedAt = nowIso();
}

async function update(id: string, fn: (i: Intent, u: User) => void): Promise<Intent> {
  return write((db) => {
    const i = db.intents[id];
    if (!i) throw new Error(`intent ${id} not found`);
    fn(i, db.users[i.userId]);
    i.updatedAt = nowIso();
    return structuredClone(i);
  });
}

type Flights = typeof globalThis & { __flights?: Map<string, Promise<unknown>> };
/** Run at most one `fn` per key at a time; concurrent callers share the same promise. */
function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Flights;
  g.__flights ??= new Map();
  const existing = g.__flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => g.__flights!.delete(key));
  g.__flights.set(key, p);
  return p;
}

export function getIntent(id: string): Intent | undefined {
  return read().intents[id];
}

export function listIntents(userId: string): Intent[] {
  return Object.values(read().intents)
    .filter((i) => i.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "reverted";
    return e.shortMessage;
  }
  return (e as Error)?.message ?? String(e);
}

// ======================================================================
// Create
// ======================================================================

export type PayInput = {
  merchantName: string;
  merchantUrl?: string;
  amountCents: number;
  description: string;
  idempotencyKey?: string;
  proceedIfMerchantDeclinedBefore?: boolean;
};

export async function createIntent(user: User, agentLabel: string, input: PayInput): Promise<Intent> {
  if (input.idempotencyKey) {
    const prior = Object.values(read().intents).find(
      (i) => i.userId === user.id && i.idempotencyKey === input.idempotencyKey,
    );
    if (prior) return prior;
  }

  const id = `chk_${randomBytes(9).toString("hex")}`;
  const domain = domainFrom(input.merchantUrl || input.merchantName);
  const intent: Intent = {
    id,
    holdId: chain.holdIdFor(id),
    userId: user.id,
    agentLabel,
    idempotencyKey: input.idempotencyKey,
    merchant: { name: input.merchantName, domain, url: input.merchantUrl },
    amountCents: input.amountCents,
    currency: "USD",
    description: input.description,
    status: "processing",
    reasons: [],
    timeline: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  push(intent, "created", `${agentLabel} asked to pay ${usd(input.amountCents)} at ${input.merchantName}`);

  const save = () =>
    write((db) => {
      db.intents[id] = intent;
      return structuredClone(intent);
    });

  // 1. Merchant memory: don't lock money for a store that is known to refuse these cards.
  const mv = merchantVerdict(domain);
  if (mv.verdict === "declines_virtual_cards" && !input.proceedIfMerchantDeclinedBefore) {
    intent.status = "rejected";
    intent.reasons.push("merchant_declines_virtual_cards");
    push(
      intent,
      "rejected",
      `${input.merchantName} declined AnyCheckout cards ${mv.declined}x before (${mv.lastDeclineReason}). Nothing was locked.`,
    );
    return save();
  }

  // 2. On-chain policy (the vault enforces the same rules again when the hold opens).
  const acct = await chain.readAccount(user.wallet);
  if (!acct.agentEnabled) {
    intent.status = "rejected";
    intent.reasons.push("agent_disabled");
    push(intent, "rejected", "Agent payments are switched off in the vault (kill switch). Nothing was locked.");
    return save();
  }
  if (acct.availableCents < input.amountCents) {
    intent.status = "rejected";
    intent.reasons.push("insufficient_balance");
    push(intent, "rejected", `Vault balance ${usd(acct.availableCents)} is below ${usd(input.amountCents)}. Top up first.`);
    return save();
  }
  const over: string[] = [];
  if (input.amountCents > acct.perPurchaseLimitCents) over.push("over_per_purchase_limit");
  if (input.amountCents > acct.remainingThisWindowCents) over.push("over_weekly_allowance");
  if (over.length) {
    intent.status = "needs_approval";
    intent.reasons = over;
    intent.approval = { required: true, reason: over.join(","), status: "pending" };
    push(
      intent,
      "approval_required",
      `${usd(input.amountCents)} is above the agent's limits (per purchase ${usd(acct.perPurchaseLimitCents)}, weekly left ${usd(acct.remainingThisWindowCents)}). Waiting for a human World ID check.`,
    );
    return save();
  }

  await save();
  return lockAndIssue(id);
}

// ======================================================================
// Lock funds + issue the card
// ======================================================================

async function lockAndIssue(id: string, approvalRef?: Hex): Promise<Intent> {
  const intent = read().intents[id];
  const user = read().users[intent.userId];
  if (!user.agentcardUserId) throw new Error("user has no card issuer account");

  // 1. Card first, so the on-chain hold can commit to this exact card id (cardRef).
  let card;
  try {
    card = await agentcard.createCard(user.agentcardUserId, intent.amountCents, intent.id);
  } catch (e) {
    return update(id, (i) => {
      i.status = "failed";
      i.reasons.push("card_issuer_error");
      push(i, "failed", `Card issuer refused: ${(e as Error).message}. Nothing was locked.`);
    });
  }

  // 2. Lock the exact amount in the Arc vault. No user signature: the vault checks the user's policy.
  try {
    const tx = await chain.openHold({
      holdId: intent.holdId,
      user: user.wallet,
      amountCents: intent.amountCents,
      ttlSeconds: config.hold.ttlSeconds,
      merchantDomain: intent.merchant.domain,
      cardId: card.id,
      approvalRef,
    });
    const [hold, receipt] = await Promise.all([
      chain.readHold(intent.holdId),
      chain.publicClient.getTransactionReceipt({ hash: tx }),
    ]);
    return update(id, (i) => {
      i.status = "card_issued";
      i.card = { id: card.id, last4: card.last4, expiry: card.expiry };
      i.hold = {
        txHash: tx,
        block: Number(receipt.blockNumber),
        openedAt: new Date(hold.openedAt * 1000).toISOString(),
        expiresAt: new Date(hold.expiresAt * 1000).toISOString(),
      };
      push(i, "locked", `Locked ${usd(i.amountCents)} USDC in the Arc vault${approvalRef ? " (World ID approved)" : ""}`, tx);
      push(i, "card_issued", `Single-use card ending ${card.last4} issued for exactly ${usd(i.amountCents)}`);
    });
  } catch (e) {
    await agentcard.closeCard(card.id).catch(() => undefined);
    const reason = revertReason(e);
    return update(id, (i) => {
      i.status = "rejected";
      i.reasons.push(reason);
      push(i, "rejected", `The vault refused the hold (${reason}). The card was closed and nothing was charged.`);
    });
  }
}

export async function getCardForAgent(user: User, id: string) {
  const intent = read().intents[id];
  if (!intent || intent.userId !== user.id) throw new Error("No such checkout for this agent");
  if (intent.status !== "card_issued" || !intent.card || intent.card.closed) {
    throw new Error(`No usable card: checkout is ${intent.status}`);
  }
  const c = await agentcard.credentials(intent.card.id);
  return {
    number: c.number,
    exp_month: c.exp_month,
    exp_year: c.exp_year,
    cvc: c.cvc,
    last4: c.last4,
    name_on_card: c.cardholder_name ?? user.name,
    billing_address: c.billing_address ?? null,
  };
}

// ======================================================================
// Human checkpoint (World ID Agent Pass, device flow)
// ======================================================================

export async function startApproval(id: string) {
  const intent = read().intents[id];
  if (!intent) throw new Error("not found");
  if (intent.status !== "needs_approval") throw new Error(`This checkout is ${intent.status}`);

  const existing = read().approvals[id];
  if (existing && existing.expiresAt > nowSec() + 30) {
    return { userCode: existing.userCode, verificationUri: existing.verificationUri, verificationUriComplete: existing.verificationUriComplete, expiresAt: existing.expiresAt };
  }
  const d = await startDeviceAuthorization();
  const startedAt = nowSec();
  const interval = d.interval ?? 5;
  await write((db) => {
    db.approvals[id] = {
      intentId: id,
      startedAt,
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUri: d.verification_uri,
      verificationUriComplete: d.verification_uri_complete,
      expiresAt: startedAt + d.expires_in,
      interval,
      nextPollAt: startedAt + interval,
    };
  });
  await update(id, (i) => {
    i.approval!.status = "verifying";
    push(i, "world_started", "Waiting for the human to verify with World ID");
  });
  return { userCode: d.user_code, verificationUri: d.verification_uri, verificationUriComplete: d.verification_uri_complete, expiresAt: startedAt + d.expires_in };
}

async function endApproval(id: string, status: "denied" | "expired" | "error", detail: string) {
  await write((db) => {
    delete db.approvals[id];
  });
  return update(id, (i) => {
    if (i.status !== "needs_approval") return;
    i.status = "denied";
    i.approval!.status = status;
    i.approval!.error = detail;
    i.approval!.decidedAt = nowIso();
    push(i, "denied", `${detail} Nothing was locked and no card was issued.`);
  });
}

export function pollApproval(id: string): Promise<Intent | undefined> {
  return singleFlight(`approval:${id}`, () => pollApprovalInner(id));
}

async function pollApprovalInner(id: string): Promise<Intent | undefined> {
  const attempt = read().approvals[id];
  const intent = read().intents[id];
  if (!intent || !attempt || intent.approval?.status !== "verifying") return intent;
  const now = nowSec();
  if (now > attempt.expiresAt) return endApproval(id, "expired", "The World ID request expired.");
  if (now < attempt.nextPollAt) return intent;

  const r = await pollDeviceToken(attempt.deviceCode);
  if (r.state === "pending" || r.state === "slow_down") {
    await write((db) => {
      const a = db.approvals[id];
      if (!a) return;
      if (r.state === "slow_down") a.interval += 5;
      a.nextPollAt = nowSec() + a.interval;
    });
    return read().intents[id];
  }
  if (r.state !== "approved") {
    if (r.state === "denied") return endApproval(id, "denied", "The human cancelled the World ID request.");
    if (r.state === "expired") return endApproval(id, "expired", "The World ID request expired.");
    return endApproval(id, "error", `World ID returned an error (${r.error}).`);
  }

  // approved: validate in the backend before trusting anything
  let human;
  try {
    human = await validateIdToken(r.idToken, attempt.startedAt);
  } catch (e) {
    return endApproval(id, "error", `World ID result failed validation: ${(e as Error).message}.`);
  }
  // Bind (iss, sub): the first approval links the account's World ID, later ones must match it.
  const user = read().users[intent.userId];
  if (user.world && (user.world.iss !== human.iss || user.world.sub !== human.sub)) {
    return endApproval(id, "denied", "A different World ID than the one linked to this account approved.");
  }
  const takenByOther = Object.values(read().users).some(
    (u) => u.id !== user.id && u.world?.iss === human.iss && u.world?.sub === human.sub,
  );
  if (takenByOther) return endApproval(id, "denied", "This World ID is already linked to another account.");

  await write((db) => {
    delete db.approvals[id];
    const u = db.users[intent.userId];
    if (!u.world) u.world = { iss: human.iss, sub: human.sub, acr: human.acr, linkedAt: nowIso() };
  });
  return update(id, (i) => {
    i.approval!.status = "verified";
    i.approval!.world = human;
    push(i, "world_verified", `World ID verified a human (${human.acr?.split("/").pop()}). Waiting for their final yes.`);
  });
}

export async function decideApproval(id: string, decision: "approve" | "deny"): Promise<Intent> {
  const intent = read().intents[id];
  if (!intent) throw new Error("not found");
  if (decision === "deny") {
    if (intent.status !== "needs_approval") throw new Error(`This checkout is ${intent.status}`);
    await write((db) => {
      delete db.approvals[id];
    });
    return update(id, (i) => {
      i.status = "denied";
      i.approval!.status = "denied";
      i.approval!.decidedAt = nowIso();
      push(i, "denied", "The human denied this purchase. Nothing was locked and no card was issued.");
    });
  }

  if (intent.status !== "needs_approval" || intent.approval?.status !== "verified" || !intent.approval.world) {
    throw new Error("Verify with World ID first");
  }
  const w = intent.approval.world;
  if (nowSec() - w.authTime > APPROVAL_FRESHNESS_SECONDS) {
    return endApproval(id, "expired", "The World ID check is older than 10 minutes. Verify again.");
  }
  const approvalRef = keccak256(toBytes(`${w.iss}|${w.sub}|${w.authTime}|${intent.id}`));
  await update(id, (i) => {
    i.status = "processing"; // consumes the approval: it can only open this one hold
    i.approval!.status = "approved";
    i.approval!.approvalRef = approvalRef;
    i.approval!.decidedAt = nowIso();
    push(i, "approved", `Human approved ${usd(i.amountCents)} at ${i.merchant.name}`);
  });
  return lockAndIssue(id, approvalRef);
}

// ======================================================================
// Card results (webhooks + reconciliation)
// ======================================================================

type IssuerEvent = { id: string; type: string; data: Record<string, unknown> };

function intentByCard(cardId: string): Intent | undefined {
  return Object.values(read().intents).find((i) => i.card?.id === cardId);
}

export async function handleIssuerEvent(evt: IssuerEvent) {
  const seen = read().webhookEventIds.includes(evt.id);
  if (seen) return;
  await write((db) => {
    db.webhookEventIds.push(evt.id);
    if (db.webhookEventIds.length > 1000) db.webhookEventIds.splice(0, db.webhookEventIds.length - 1000);
  });

  const cardId = String(evt.data.card_id ?? evt.data.id ?? "");
  const intent = intentByCard(cardId);
  if (!intent) return;

  if (evt.type === "card.closed") {
    await update(intent.id, (i) => {
      if (i.card) i.card.closed = true;
    });
    return;
  }
  if (evt.type === "transaction.authorized") {
    await update(intent.id, (i) => push(i, "authorized", `Merchant authorized ${usd(Number(evt.data.amount))}`));
    return;
  }
  if (evt.type === "transaction.cleared") {
    await onCharge(intent.id, { id: String(evt.data.id), amount: Number(evt.data.amount), status: "cleared", decline_reason: null });
  }
  if (evt.type === "transaction.declined" || evt.type === "transaction.voided") {
    await onCharge(intent.id, {
      id: String(evt.data.id),
      amount: Number(evt.data.amount),
      status: evt.type === "transaction.declined" ? "declined" : "voided",
      decline_reason: (evt.data.decline_reason as string) ?? null,
    });
  }
}

type ChargeInfo = { id: string; amount: number; status: "cleared" | "declined" | "voided"; decline_reason: string | null };

function onCharge(id: string, t: ChargeInfo) {
  return singleFlight(`charge:${id}`, () => onChargeInner(id, t));
}

async function onChargeInner(id: string, t: ChargeInfo) {
  const intent = read().intents[id];
  if (!intent || intent.charge?.transactionId === t.id || !["card_issued", "charged", "declined"].includes(intent.status)) return;

  if (t.status === "cleared") {
    await recordMerchant(intent.merchant.domain, intent.merchant.name, "accepted");
    await update(id, (i) => {
      i.status = "charged";
      i.charge = { transactionId: t.id, amountCents: t.amount, status: "cleared", at: nowIso() };
      push(i, "charged", `${i.merchant.name} charged ${usd(t.amount)} (card limit ${usd(i.amountCents)})`);
    });
  } else {
    await recordMerchant(intent.merchant.domain, intent.merchant.name, "declined", t.decline_reason ?? t.status);
    // One attempt per card: close it so a retry can never succeed after we refund.
    if (intent.card) await agentcard.closeCard(intent.card.id).catch(() => undefined);
    await update(id, (i) => {
      i.status = "declined";
      i.charge = { transactionId: t.id, amountCents: t.amount, status: t.status, declineReason: t.decline_reason ?? undefined, at: nowIso() };
      if (i.card) i.card.closed = true;
      push(i, "declined", `${i.merchant.name} declined the card (${t.decline_reason ?? t.status}). Card closed. Remembered this merchant.`);
    });
  }
  await requestSettlement(id);
}

// ======================================================================
// Settlement (Chainlink CRE, or the local forwarder on anvil)
// ======================================================================

export function requestSettlement(id: string, why = "card result") {
  return singleFlight(`settle:${id}`, () => requestSettlementInner(id, why));
}

async function requestSettlementInner(id: string, why: string) {
  const intent = read().intents[id];
  if (!intent?.card || !intent.hold || intent.settlement?.txHash) return;
  if (["settled", "refunded"].includes(intent.status)) return;

  if (config.settlement.mode === "cre") {
    try {
      const res = await fetch(config.settlement.creTriggerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { holdId: intent.holdId, cardId: intent.card.id, intentId: intent.id } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await update(id, (i) => {
        i.settlement = { ...(i.settlement ?? {}), requestedAt: nowIso(), via: "cre", error: undefined };
        push(i, "cre_triggered", `Chainlink CRE workflow triggered (${why}): it reads the card result from Agentcard and writes the report to Arc`);
      });
      return;
    } catch (e) {
      const canFallback = config.settlement.fallbackToLocal && Boolean(config.chain.localForwarder);
      await update(id, (i) => {
        i.settlement = { ...(i.settlement ?? {}), error: `CRE unreachable: ${(e as Error).message}` };
        push(i, "cre_unreachable", `CRE workflow not reachable at ${config.settlement.creTriggerUrl}${canFallback ? ", using the local forwarder" : ", will retry"}`);
      });
      if (!canFallback) return;
    }
  }
  await settleLocally(id);
}

async function settleLocally(id: string) {
  const intent = read().intents[id];
  if (!intent?.card) return;
  const [{ data }, card, hold] = await Promise.all([
    agentcard.listTransactions(intent.card.id),
    agentcard.getCard(intent.card.id).catch(() => null),
    chain.readHold(intent.holdId),
  ]);
  if (hold.status !== "open") return finalizeFromChain(id);
  const decision = decideSettlement({
    txns: data,
    holdAmountCents: hold.amountCents,
    holdExpiresAt: hold.expiresAt,
    nowSeconds: nowSec(),
    cardClosed: card?.status === "closed",
  });
  if (decision.action === "wait") return;
  const report = chain.encodeReport({
    action: decision.action === "settle" ? chain.ACTION_SETTLE : chain.ACTION_REFUND,
    holdId: intent.holdId,
    chargedCents: decision.action === "settle" ? decision.chargedCents : 0,
    ref: chain.refHash(decision.ref),
  });
  try {
    const tx = await chain.forwardReportLocally(report);
    await update(id, (i) => {
      i.settlement = { ...(i.settlement ?? {}), via: "local", txHash: tx, action: decision.action === "settle" ? "settle" : "refund", requestedAt: i.settlement?.requestedAt ?? nowIso() };
    });
    return finalizeFromChain(id, tx);
  } catch (e) {
    await update(id, (i) => {
      i.settlement = { ...(i.settlement ?? {}), error: revertReason(e) };
      push(i, "settlement_error", `Settlement transaction failed: ${revertReason(e)}`);
    });
  }
}

async function findSettlementTx(intent: Intent): Promise<Hex | undefined> {
  const fromBlock = intent.hold?.block ? BigInt(intent.hold.block) : undefined;
  for (const eventName of ["HoldSettled", "HoldRefunded"] as const) {
    const logs = await chain.publicClient
      .getContractEvents({
        address: config.chain.vault,
        abi: (await import("./abi/AnyCheckoutVault")).AnyCheckoutVaultAbi,
        eventName,
        args: { holdId: intent.holdId },
        fromBlock,
      })
      .catch(() => []);
    if (logs.length) return logs[logs.length - 1].transactionHash as Hex;
  }
  return undefined;
}

async function finalizeFromChain(id: string, tx?: Hex) {
  const intent = read().intents[id];
  if (!intent || ["settled", "refunded"].includes(intent.status)) return;
  const hold = await chain.readHold(intent.holdId);
  if (hold.status === "open" || hold.status === "none") return;
  const txHash = tx ?? (await findSettlementTx(intent));
  await update(id, (i) => {
    const charged = hold.status === "settled" ? hold.chargedCents : 0;
    const refunded = hold.amountCents - charged;
    i.status = hold.status === "settled" ? "settled" : "refunded";
    i.settlement = { ...(i.settlement ?? {}), txHash, chargedCents: charged, refundedCents: refunded, at: nowIso(), action: hold.status === "settled" ? "settle" : "refund" };
    push(
      i,
      i.status,
      hold.status === "settled"
        ? `Settled on Arc: ${usd(charged)} paid to the card float, ${usd(refunded)} returned to the vault`
        : `Refunded on Arc: ${usd(refunded)} returned to the vault`,
      txHash,
    );
  });
}

/** Demo control: the agent abandoned checkout. Close the card, then the normal refund path runs. */
export async function abandonCheckout(id: string) {
  const intent = read().intents[id];
  if (!intent?.card || intent.status !== "card_issued") throw new Error("Only an issued, unused card can be abandoned");
  await agentcard.closeCard(intent.card.id);
  await update(id, (i) => {
    if (i.card) i.card.closed = true;
    push(i, "card_closed", "Checkout abandoned: card closed before any charge");
  });
  await requestSettlement(id, "card closed unused");
}

// ======================================================================
// Background reconciliation (catches missed webhooks, timeouts, CRE results)
// ======================================================================

type LoopGlobals = typeof globalThis & {
  __reconcileTimer?: ReturnType<typeof setInterval>;
  __reconcileFn?: () => Promise<void>;
  __reconcileRunning?: boolean;
};
const lg = globalThis as LoopGlobals;

async function settleOrRetry(intent: Intent, now: number) {
  await finalizeFromChain(intent.id);
  const fresh = read().intents[intent.id];
  if (!fresh || ["settled", "refunded"].includes(fresh.status)) return;
  const last = fresh.settlement?.requestedAt ? Date.parse(fresh.settlement.requestedAt) / 1000 : 0;
  if (now - last > 45) await requestSettlement(intent.id, "retry");
  // Trustless fallback: after ttl + grace anyone may refund on-chain. Never for a charged card.
  if (fresh.status === "charged") return;
  const hold = await chain.readHold(intent.holdId);
  if (hold.status !== "open") return;
  const { AnyCheckoutVaultAbi } = await import("./abi/AnyCheckoutVault");
  const grace = Number(
    await chain.publicClient.readContract({ address: config.chain.vault, abi: AnyCheckoutVaultAbi, functionName: "settlementGrace" }),
  );
  if (now >= hold.expiresAt + grace) {
    const tx = await chain.expireHold(intent.holdId);
    await finalizeFromChain(intent.id, tx);
  }
}

export async function reconcileOnce() {
  if (lg.__reconcileRunning || !chain.isConfigured()) return;
  lg.__reconcileRunning = true;
  try {
    const now = nowSec();
    for (const intent of Object.values(read().intents)) {
      try {
        if (intent.status === "needs_approval" && intent.approval?.status === "verifying") {
          await pollApproval(intent.id);
          continue;
        }
        if (["charged", "declined"].includes(intent.status)) {
          await settleOrRetry(intent, now);
          continue;
        }
        if (intent.status !== "card_issued" || !intent.card || !intent.hold) continue;
        if (intent.card.closed) {
          await settleOrRetry(intent, now);
          continue;
        }
        // Missed webhook? Ask the issuer directly (every 10s per card).
        if (!intent.card.lastPolledAt || now - intent.card.lastPolledAt >= 10) {
          await update(intent.id, (i) => {
            if (i.card) i.card.lastPolledAt = now;
          });
          const { data } = await agentcard.listTransactions(intent.card.id);
          const done = data.find((t: AgentcardTransaction) => ["cleared", "declined", "voided"].includes(t.status));
          if (done) {
            await onCharge(intent.id, {
              id: done.id,
              amount: done.amount ?? 0,
              status: done.status as "cleared" | "declined" | "voided",
              decline_reason: done.decline_reason,
            });
            continue;
          }
        }
        // Timeout: close the unused card, then refund through the normal path.
        if (now >= Date.parse(intent.hold.expiresAt) / 1000) {
          await agentcard.closeCard(intent.card.id).catch(() => undefined);
          await update(intent.id, (i) => {
            if (i.card) i.card.closed = true;
            push(i, "card_closed", "Card expired unused: closed it, requesting a refund");
          });
          await requestSettlement(intent.id, "timeout");
        }
      } catch (e) {
        console.warn(`[reconcile] ${intent.id}:`, (e as Error).message);
      }
    }
  } finally {
    lg.__reconcileRunning = false;
  }
}

// The timer always calls the newest reconcileOnce, so hot reloads in dev never leave stale code running.
lg.__reconcileFn = reconcileOnce;

export function ensureBackgroundLoop() {
  if (lg.__reconcileTimer) return;
  lg.__reconcileTimer = setInterval(() => void lg.__reconcileFn?.(), 3000);
}

// ======================================================================
// What the agent sees
// ======================================================================

export function agentView(i: Intent) {
  const base = {
    intent_id: i.id,
    status: i.status,
    merchant: i.merchant.name,
    amount: (i.amountCents / 100).toFixed(2),
    currency: i.currency,
  };
  switch (i.status) {
    case "needs_approval":
      return {
        ...base,
        approval_url: `${config.appUrl}/approve/${i.id}`,
        reason: i.reasons,
        next_step:
          "This purchase is above the limits your human set. Send them the approval_url and ask them to verify with World ID. Then call anycheckout_status with this intent_id until status is card_issued, and call anycheckout_get_card. You cannot approve this yourself.",
      };
    case "card_issued":
      return {
        ...base,
        card_last4: i.card?.last4,
        expires_at: i.hold?.expiresAt,
        next_step: "Call anycheckout_get_card to read the card details, type them into the checkout form, and submit. Then call anycheckout_status.",
      };
    case "charged":
    case "declined":
      return { ...base, charge: i.charge, next_step: "Settlement is in progress on Arc. Call anycheckout_status again in a few seconds." };
    case "settled":
      return {
        ...base,
        charged: ((i.settlement?.chargedCents ?? 0) / 100).toFixed(2),
        refunded_to_user: ((i.settlement?.refundedCents ?? 0) / 100).toFixed(2),
        settlement_tx: i.settlement?.txHash,
        next_step: "Done. Tell your human the order is paid.",
      };
    case "refunded":
      return {
        ...base,
        refunded_to_user: ((i.settlement?.refundedCents ?? i.amountCents) / 100).toFixed(2),
        settlement_tx: i.settlement?.txHash,
        decline_reason: i.charge?.declineReason,
        next_step:
          i.charge?.status === "declined"
            ? "The merchant refused the card and the user got a full refund. Try another merchant."
            : "The card was not used, so the user got a full refund.",
      };
    case "rejected":
    case "denied":
    case "failed":
      return { ...base, reason: i.reasons.length ? i.reasons : [i.approval?.status ?? "unknown"], detail: i.timeline.at(-1)?.detail, next_step: "Do not retry the same purchase. Tell your human what happened." };
    default:
      return { ...base, next_step: "Working on it. Call anycheckout_status again in a few seconds." };
  }
}

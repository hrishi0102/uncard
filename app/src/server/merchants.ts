import "server-only";
import { read, write } from "./store";
import type { MerchantMemory } from "./types";

/**
 * Merchant memory: which stores take AnyCheckout's single-use virtual cards and which refuse them.
 * Shared across every agent, so one decline saves everyone else a wasted lock.
 */

/** Decline reasons that mean "this merchant refuses this kind of card" (not a one-off failure). */
const CARD_TYPE_REASONS = new Set([
  "card_not_supported",
  "prepaid_card_not_accepted",
  "virtual_card_not_accepted",
  "card_type_not_accepted",
  "do_not_honor",
  "restricted_card",
]);

export function domainFrom(urlOrName: string): string {
  const s = urlOrName.trim().toLowerCase();
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    if (u.hostname.includes(".")) return u.hostname.replace(/^www\./, "");
  } catch {
    // fall through
  }
  return s.replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function lookupMerchant(domain: string): MerchantMemory | undefined {
  return read().merchants[domain];
}

export function merchantVerdict(domain: string) {
  const m = lookupMerchant(domain);
  if (!m) return { known: false as const, verdict: "unknown" as const };
  const blocks = m.declined > 0 && m.accepted === 0 && m.lastDeclineReason && CARD_TYPE_REASONS.has(m.lastDeclineReason);
  return {
    known: true as const,
    verdict: blocks ? ("declines_virtual_cards" as const) : m.accepted > 0 ? ("accepts" as const) : ("mixed" as const),
    accepted: m.accepted,
    declined: m.declined,
    lastDeclineReason: m.lastDeclineReason,
  };
}

export async function recordMerchant(domain: string, name: string, outcome: "accepted" | "declined", reason?: string) {
  await write((db) => {
    const m = (db.merchants[domain] ??= { domain, name, accepted: 0, declined: 0, lastSeen: new Date().toISOString() });
    m.name = name || m.name;
    m.lastSeen = new Date().toISOString();
    if (outcome === "accepted") m.accepted += 1;
    else {
      m.declined += 1;
      m.lastDeclineReason = reason;
    }
  });
}

export function listMerchants(): MerchantMemory[] {
  return Object.values(read().merchants).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SiteHeader } from "@/components/brand";
import { Receipt } from "@/components/receipt";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { shortHex, usd } from "@/lib/format";
import type { Intent, MerchantMemory } from "@/server/types";

type Dash = {
  configured: boolean;
  error?: string;
  modes: { chain: string; chainId: number; cardIssuer: string; settlement: string; world: string; uniswap: string };
  user: { name: string; wallet: string; world: { sub: string; linkedAt: string; acr?: string } | null };
  account: {
    availableCents: number;
    lockedCents: number;
    weeklyLimitCents: number;
    perPurchaseLimitCents: number;
    spentInWindowCents: number;
    remainingThisWindowCents: number;
    agentEnabled: boolean;
  };
  walletUsdcCents: number | null;
  intents: Intent[];
  merchants: MerchantMemory[];
  contracts: { vault: string; usdc: string; chainId: number; chainName: string; explorer: string | null };
  mcp: { url: string; agentKey: string };
  isLocalChain: boolean;
};

const MODE_LABEL: Record<string, Record<string, string>> = {
  cardIssuer: { mock: "Mock Agentcard (same API)", agentcard: "Agentcard sandbox" },
  settlement: { local: "Local forwarder", cre: "Chainlink CRE workflow" },
  world: { mock: "Mock World IdP (real RS256 tokens)", sandbox: "World ID sandbox", production: "World ID" },
};

async function post(url: string, body?: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`Copied ${what}`),
    () => toast.error("Copy failed"),
  );
}

export default function Dashboard() {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [weekly, setWeekly] = useState("");
  const [perPurchase, setPerPurchase] = useState("");
  const [showKey, setShowKey] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      const data = (await res.json()) as Dash;
      if (!res.ok || data.error) setErr(data.error ?? `HTTP ${res.status}`);
      else {
        setErr(null);
        setD(data);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (d && weekly === "" && perPurchase === "") {
      setWeekly(String(d.account.weeklyLimitCents / 100));
      setPerPurchase(String(d.account.perPurchaseLimitCents / 100));
    }
  }, [d, weekly, perPurchase]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (err && !d) {
    return (
      <main>
        <SiteHeader />
        <div className="mx-auto max-w-2xl px-4 py-16">
          <h1 className="text-2xl font-semibold">The vault is not reachable yet</h1>
          <p className="mt-2 text-[var(--muted-foreground)]">{err}</p>
          <pre className="mt-6 overflow-x-auto rounded-md bg-[var(--paper)] p-4 font-mono text-sm">npm run chain{"\n"}npm run local:setup{"\n"}npm run dev</pre>
        </div>
      </main>
    );
  }
  if (!d) {
    return (
      <main>
        <SiteHeader />
        <p className="mx-auto max-w-6xl px-4 py-16 text-[var(--muted-foreground)]">Reading your vault on {""}Arc…</p>
      </main>
    );
  }

  const a = d.account;
  const spentPct = a.weeklyLimitCents ? Math.min(100, Math.round((a.spentInWindowCents / a.weeklyLimitCents) * 100)) : 0;
  const pending = d.intents.filter((i) => i.status === "needs_approval");
  const claudeCmd = `claude mcp add --transport http anycheckout ${d.mcp.url} --header "Authorization: Bearer ${d.mcp.agentKey}"`;
  const desktopJson = JSON.stringify(
    { mcpServers: { anycheckout: { command: "npx", args: ["-y", "mcp-remote", d.mcp.url, "--header", `Authorization: Bearer ${d.mcp.agentKey}`] } } },
    null,
    2,
  );

  return (
    <main className="pb-24">
      <SiteHeader />

      {pending.length > 0 && (
        <div className="border-b border-[var(--ink)] bg-[var(--taxi)]">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <span>
              Your agent is waiting for your approval on {pending.length === 1 ? `a ${usd(pending[0].amountCents)} purchase at ${pending[0].merchant.name}` : `${pending.length} purchases`}.
            </span>
            <Link href={`/approve/${pending[0].id}`} className="rounded-md bg-[var(--ink)] px-3 py-1.5 font-medium text-white">
              Review and approve
            </Link>
          </div>
        </div>
      )}

      <div className="mx-auto grid max-w-6xl gap-8 px-4 pt-8 lg:grid-cols-[1fr_360px]">
        {/* ------------- left: money + checkouts ------------- */}
        <section className="min-w-0 space-y-8">
          <div className="rounded-lg bg-[var(--paper)] p-5">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="text-sm text-[var(--muted-foreground)]">Spendable in your vault on {d.contracts.chainName}</p>
                <p className="money mt-1 text-[2.6rem] leading-none font-semibold">{usd(a.availableCents)}</p>
                <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                  {usd(a.lockedCents)} locked in open checkouts. USDC, withdraw any time.
                </p>
              </div>
              <div className="w-full max-w-xs">
                <div className="flex justify-between text-sm">
                  <span>Agent spent this week</span>
                  <span className="money">
                    {usd(a.spentInWindowCents)} of {usd(a.weeklyLimitCents)}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--muted)]">
                  <div className="h-full bg-[var(--carbon)]" style={{ width: `${spentPct}%` }} />
                </div>
                <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                  Up to {usd(a.perPurchaseLimitCents)} per purchase without asking you. Above that, you approve with World ID.
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-[var(--hairline)] pt-4">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={a.agentEnabled}
                  disabled={!d.isLocalChain || busy !== null}
                  onCheckedChange={(v) =>
                    run("kill", () => post("/api/demo/policy", { weekly: a.weeklyLimitCents / 100, perPurchase: a.perPurchaseLimitCents / 100, enabled: v }), v ? "Agent payments on" : "Agent payments paused")
                  }
                />
                {a.agentEnabled ? "Agent can pay" : "Agent payments paused"}
              </label>
              {d.isLocalChain ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run("policy", () => post("/api/demo/policy", { weekly: Number(weekly), perPurchase: Number(perPurchase), enabled: a.agentEnabled }), "Limits saved on-chain");
                  }}
                >
                  <div>
                    <Label htmlFor="weekly" className="text-xs">Weekly allowance ($)</Label>
                    <Input id="weekly" inputMode="decimal" className="h-8 w-28 bg-white" value={weekly} onChange={(e) => setWeekly(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="per" className="text-xs">Per purchase ($)</Label>
                    <Input id="per" inputMode="decimal" className="h-8 w-28 bg-white" value={perPurchase} onChange={(e) => setPerPurchase(e.target.value)} />
                  </div>
                  <Button type="submit" size="sm" variant="outline" disabled={busy !== null}>
                    {busy === "policy" ? "Saving…" : "Save limits"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => run("dep", () => post("/api/demo/deposit", { amount: 100 }), "Deposited 100 test USDC")}>
                    {busy === "dep" ? "Depositing…" : "Add 100 test USDC"}
                  </Button>
                </form>
              ) : (
                <Link href="/topup" className="text-sm text-[var(--carbon)] underline">
                  Top up with any token, or change limits from your wallet
                </Link>
              )}
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-xl font-semibold">Checkouts</h2>
              <Link href="/shop" className="text-sm text-[var(--carbon)] underline">
                Open the demo shops
              </Link>
            </div>
            {d.intents.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--input)] p-8 text-center">
                <p className="font-medium">No checkouts yet</p>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                  Connect your agent on the right, then ask it to buy something from a demo shop.
                </p>
              </div>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2">
                {d.intents.map((i, idx) => (
                  <Receipt
                    key={i.id}
                    intent={i}
                    explorer={d.contracts.explorer}
                    defaultOpen={idx === 0}
                    actions={
                      <>
                        {i.status === "needs_approval" && (
                          <Link href={`/approve/${i.id}`} className="rounded-md bg-[var(--taxi)] px-3 py-1.5 text-sm font-medium">
                            Review and approve
                          </Link>
                        )}
                        {i.status === "card_issued" && (
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run(`ab-${i.id}`, () => post(`/api/intents/${i.id}/abandon`), "Card closed, refund requested")}>
                            Cancel this card
                          </Button>
                        )}
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ------------- right: agent + system ------------- */}
        <aside className="space-y-6">
          <div className="rounded-lg bg-[var(--paper)] p-5">
            <h2 className="font-semibold">Connect your agent</h2>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">One MCP server, five tools. Works with Claude, Cursor, or any MCP client.</p>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-xs text-[var(--muted-foreground)]">Server URL</dt>
                <dd className="flex items-center justify-between gap-2">
                  <code className="truncate font-mono text-[0.8rem]">{d.mcp.url}</code>
                  <Button size="xs" variant="ghost" onClick={() => copy(d.mcp.url, "URL")}>Copy</Button>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--muted-foreground)]">Agent key</dt>
                <dd className="flex items-center justify-between gap-2">
                  <code className="truncate font-mono text-[0.8rem]">{showKey ? d.mcp.agentKey : "ak_••••••••••••"}</code>
                  <span className="flex gap-1">
                    <Button size="xs" variant="ghost" onClick={() => setShowKey((v) => !v)}>{showKey ? "Hide" : "Show"}</Button>
                    <Button size="xs" variant="ghost" onClick={() => copy(d.mcp.agentKey, "agent key")}>Copy</Button>
                  </span>
                </dd>
              </div>
            </dl>
            <div className="mt-4 space-y-2">
              <Button size="sm" variant="outline" className="w-full justify-start" onClick={() => copy(claudeCmd, "Claude Code command")}>
                Copy Claude Code command
              </Button>
              <Button size="sm" variant="outline" className="w-full justify-start" onClick={() => copy(desktopJson, "Claude Desktop config")}>
                Copy Claude Desktop config
              </Button>
            </div>
          </div>

          <div className="rounded-lg bg-[var(--paper)] p-5">
            <h2 className="font-semibold">Human check</h2>
            {d.user.world ? (
              <p className="mt-1 text-sm">
                World ID linked <span className="text-[var(--muted-foreground)]">({shortHex(d.user.world.sub, 10)}, {d.user.world.acr?.split("/").pop()})</span>. Only this
                World ID can approve big purchases.
              </p>
            ) : (
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                Not linked yet. The first World ID that approves a purchase gets linked to this vault, and every later approval must match it.
              </p>
            )}
          </div>

          <div className="rounded-lg bg-[var(--paper)] p-5">
            <h2 className="font-semibold">Merchant memory</h2>
            {d.merchants.length === 0 ? (
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">Stores that refuse virtual cards show up here, so no agent locks money there twice.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {d.merchants.map((m) => {
                  const blocks = m.declined > 0 && m.accepted === 0;
                  return (
                    <li key={m.domain} className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{m.name}</span>
                        <span className="block truncate text-xs text-[var(--muted-foreground)]">
                          {m.accepted} paid, {m.declined} declined{m.lastDeclineReason ? ` (${m.lastDeclineReason.replaceAll("_", " ")})` : ""}
                        </span>
                      </span>
                      <span className="text-xs font-medium" style={{ color: blocks ? "var(--stop)" : "var(--go)" }}>
                        {blocks ? "Refuses cards" : "Accepts"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="rounded-lg bg-[var(--paper)] p-5 text-sm">
            <h2 className="font-semibold">How this demo is wired</h2>
            <dl className="mt-3 space-y-2">
              <div className="flex justify-between gap-3"><dt className="text-[var(--muted-foreground)]">Escrow</dt><dd className="text-right">{d.contracts.chainName}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--muted-foreground)]">Vault</dt><dd className="font-mono text-[0.78rem]">{shortHex(d.contracts.vault)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--muted-foreground)]">Cards</dt><dd className="text-right">{MODE_LABEL.cardIssuer[d.modes.cardIssuer]}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--muted-foreground)]">Settlement</dt><dd className="text-right">{MODE_LABEL.settlement[d.modes.settlement]}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--muted-foreground)]">Human check</dt><dd className="text-right">{MODE_LABEL.world[d.modes.world]}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--muted-foreground)]">Swaps</dt><dd className="text-right">{d.modes.uniswap === "live" ? "Uniswap API" : "Uniswap API (add key)"}</dd></div>
            </dl>
          </div>
        </aside>
      </div>
    </main>
  );
}

"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { usd } from "@/lib/format";

type View = {
  intent: {
    id: string;
    status: string;
    merchant: { name: string; domain: string; url?: string };
    amountCents: number;
    description: string;
    reasons: string[];
    agentLabel: string;
    approval?: { status: string; error?: string; world?: { acr?: string; authTime: number } };
    card?: { last4: string };
  };
  attempt: { userCode: string; verificationUri: string; verificationUriComplete?: string; expiresAt: number } | null;
  worldMode: string;
  worldLinked: boolean;
};

const REASON: Record<string, string> = {
  over_per_purchase_limit: "It is above your per-purchase limit.",
  over_weekly_allowance: "It is more than your agent has left this week.",
};

export default function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [v, setV] = useState<View | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/approvals/${id}`, { cache: "no-store" });
    if (res.status === 404) return setNotFound(true);
    setV(await res.json());
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [load]);

  const act = async (url: string, body?: unknown) => {
    setBusy(true);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (notFound) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">This approval link is not valid</h1>
        <p className="mt-2 text-[var(--muted-foreground)]">Ask your agent for a new link.</p>
      </Shell>
    );
  }
  if (!v) return <Shell><p className="text-[var(--muted-foreground)]">Loading the purchase…</p></Shell>;

  const i = v.intent;
  const ap = i.approval?.status;
  const done = ["processing", "card_issued", "charged", "settled", "refunded", "declined"].includes(i.status);

  return (
    <Shell>
      <p className="text-sm text-[var(--muted-foreground)]">{i.agentLabel} wants to pay</p>
      <p className="money mt-1 text-[3rem] leading-none font-semibold">{usd(i.amountCents)}</p>
      <p className="mt-3 text-lg font-medium">{i.merchant.name}</p>
      <p className="text-[var(--muted-foreground)]">{i.description}</p>
      <p className="mt-1 text-sm text-[var(--muted-foreground)]">{i.merchant.domain}</p>

      {i.status === "needs_approval" && (
        <div className="mt-6 rounded-md border border-[var(--hairline)] bg-[var(--accent)] p-3 text-sm">
          {i.reasons.map((r) => (
            <p key={r}>{REASON[r] ?? r}</p>
          ))}
          <p className="mt-1 text-[var(--muted-foreground)]">Your agent cannot approve this on its own. Only you can, with World ID.</p>
        </div>
      )}

      <div className="mt-6">
        {i.status === "needs_approval" && (ap === "pending" || ap === "error" || !ap) && (
          <div className="space-y-3">
            <Button className="h-11 w-full bg-[var(--ink)] text-base text-white hover:bg-[var(--ink)]/90" disabled={busy} onClick={() => act(`/api/approvals/${id}/start`)}>
              Verify with World ID
            </Button>
            <Button variant="ghost" className="w-full" disabled={busy} onClick={() => act(`/api/approvals/${id}/decide`, { decision: "deny" })}>
              Deny this purchase
            </Button>
          </div>
        )}

        {i.status === "needs_approval" && ap === "verifying" && v.attempt && (
          <div className="space-y-4">
            <p className="font-medium">Scan with World App, or open the link on this phone</p>
            <div className="flex items-center gap-5">
              <div className="rounded-md bg-white p-2">
                <QRCodeSVG value={v.attempt.verificationUriComplete ?? v.attempt.verificationUri} size={132} />
              </div>
              <div className="text-sm">
                <p className="text-[var(--muted-foreground)]">Code</p>
                <p className="money text-2xl font-semibold">{v.attempt.userCode}</p>
                <a className="mt-2 inline-block text-[var(--carbon)] underline" href={v.attempt.verificationUriComplete ?? v.attempt.verificationUri} target="_blank" rel="noreferrer">
                  Open World App{v.worldMode === "mock" ? " (simulated)" : ""}
                </a>
              </div>
            </div>
            <p className="text-sm text-[var(--muted-foreground)]">Waiting for World App. This page updates by itself.</p>
            <Button variant="ghost" className="w-full" disabled={busy} onClick={() => act(`/api/approvals/${id}/decide`, { decision: "deny" })}>
              Deny this purchase
            </Button>
          </div>
        )}

        {i.status === "needs_approval" && ap === "verified" && (
          <div className="space-y-3">
            <p className="text-sm">
              World ID confirmed a verified human{v.worldLinked ? " and it matches the World ID linked to this vault" : ""}. Approve this exact purchase?
            </p>
            <Button className="h-11 w-full bg-[var(--taxi)] text-base text-[var(--ink)] hover:bg-[var(--taxi)]/90" disabled={busy} onClick={() => act(`/api/approvals/${id}/decide`, { decision: "approve" })}>
              Approve {usd(i.amountCents)}
            </Button>
            <Button variant="ghost" className="w-full" disabled={busy} onClick={() => act(`/api/approvals/${id}/decide`, { decision: "deny" })}>
              Deny
            </Button>
          </div>
        )}

        {done && (
          <div className="rounded-md border border-[var(--go)] p-4">
            <p className="font-medium text-[var(--go)]">Approved</p>
            <p className="mt-1 text-sm">
              {usd(i.amountCents)} is locked in your vault and your agent has a single-use card{i.card ? ` ending ${i.card.last4}` : ""} for exactly that amount. Only what the
              merchant charges is paid. The rest comes back to you.
            </p>
          </div>
        )}

        {i.status === "denied" && (
          <div className="rounded-md border border-[var(--stop)] p-4">
            <p className="font-medium text-[var(--stop)]">Not approved</p>
            <p className="mt-1 text-sm">{i.approval?.error ?? "You denied this purchase."} Nothing was locked and no card was issued.</p>
          </div>
        )}

        {["rejected", "failed"].includes(i.status) && (
          <div className="rounded-md border border-[var(--stop)] p-4 text-sm">This purchase could not go ahead ({i.reasons.join(", ")}).</div>
        )}
      </div>

      <p className="mt-10 text-center text-sm">
        <Link href="/dashboard" className="text-[var(--carbon)] underline">Open your dashboard</Link>
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh">
      <div className="taxi-stripe" />
      <div className="mx-auto max-w-md px-4 py-8">
        <Wordmark />
        <div className="receipt mt-6 rounded-t-md px-5 pt-6 font-sans">{children}</div>
      </div>
    </main>
  );
}

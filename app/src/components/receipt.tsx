"use client";

import { useState } from "react";
import type { Intent, IntentStatus } from "@/server/types";
import { shortHex, timeAgo, usd } from "@/lib/format";

const STAMP: Record<IntentStatus, { label: string; color: string; bg?: string }> = {
  processing: { label: "Working", color: "var(--muted-foreground)" },
  needs_approval: { label: "Needs you", color: "var(--ink)", bg: "var(--taxi)" },
  card_issued: { label: "Card issued", color: "var(--carbon)" },
  charged: { label: "Charged, settling", color: "var(--carbon)" },
  declined: { label: "Declined, refunding", color: "var(--stop)" },
  settled: { label: "Settled", color: "var(--go)" },
  refunded: { label: "Refunded", color: "var(--go)" },
  denied: { label: "Denied", color: "var(--stop)" },
  rejected: { label: "Not sent", color: "var(--stop)" },
  failed: { label: "Failed", color: "var(--stop)" },
};

export function StatusStamp({ status }: { status: IntentStatus }) {
  const s = STAMP[status];
  return (
    <span className="stamp text-[0.72rem]" style={{ color: s.color, background: s.bg, borderColor: s.bg ? "var(--ink)" : undefined }}>
      {s.label}
    </span>
  );
}

function Line({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${muted ? "text-[var(--muted-foreground)]" : ""}`}>
      <span>{label}</span>
      <span className={`money ${strong ? "text-[1.05rem] font-semibold" : ""}`}>{value}</span>
    </div>
  );
}

export function receiptAmounts(i: Intent) {
  const locked = i.hold ? i.amountCents : undefined;
  const charged =
    i.settlement?.chargedCents ?? (i.charge?.status === "cleared" ? i.charge.amountCents : i.status === "refunded" ? 0 : undefined);
  const returned = i.settlement?.refundedCents ?? (charged !== undefined && locked !== undefined ? locked - charged : undefined);
  return { locked, charged, returned };
}

export function Receipt({
  intent,
  explorer,
  actions,
  defaultOpen = false,
}: {
  intent: Intent;
  explorer?: string | null;
  actions?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { locked, charged, returned } = receiptAmounts(intent);
  const txLink = (h?: string) => (h && explorer ? `${explorer.replace(/\/$/, "")}/tx/${h}` : undefined);

  return (
    <article className="receipt print-in w-full rounded-t-md px-4 pt-4 text-[0.82rem] shadow-[0_1px_0_var(--hairline)]">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-sans text-[0.98rem] font-semibold">{intent.merchant.name}</h3>
          <p className="truncate text-[var(--muted-foreground)]">{intent.description}</p>
        </div>
        <StatusStamp status={intent.status} />
      </header>

      <hr className="receipt-rule" />
      <Line label="Cart total" value={usd(intent.amountCents)} muted />
      <Line label="Locked in vault" value={usd(locked)} />
      <Line label="Charged by merchant" value={usd(charged)} />
      <hr className="receipt-rule" />
      <Line label="Returned to you" value={usd(returned)} strong />
      <hr className="receipt-rule" />

      <div className="flex flex-wrap items-center justify-between gap-2 text-[var(--muted-foreground)]">
        <span>
          {intent.card ? `Card •••• ${intent.card.last4}` : "No card issued"}, asked by {intent.agentLabel}{" "}
          {timeAgo(intent.createdAt)}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="font-sans text-[var(--carbon)] underline-offset-2 hover:underline"
          aria-expanded={open}
        >
          {open ? "Hide steps" : "Show steps"}
        </button>
      </div>

      {open && (
        <ol className="mt-3 space-y-1.5 border-l border-dashed border-[#b9bdb5] pl-3">
          {intent.timeline.map((t, idx) => (
            <li key={idx} className="leading-snug">
              <span className="text-[var(--muted-foreground)]">{new Date(t.at).toLocaleTimeString()}</span>{" "}
              <span className="font-sans">{t.detail}</span>
              {t.tx && (
                <>
                  {" "}
                  {txLink(t.tx) ? (
                    <a className="text-[var(--carbon)] underline" href={txLink(t.tx)} target="_blank" rel="noreferrer">
                      {shortHex(t.tx)}
                    </a>
                  ) : (
                    <span className="text-[var(--carbon)]">{shortHex(t.tx)}</span>
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {actions && <div className="mt-3 flex flex-wrap gap-2 font-sans">{actions}</div>}
    </article>
  );
}

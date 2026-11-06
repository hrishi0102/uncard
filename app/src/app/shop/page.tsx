import Link from "next/link";
import { SiteHeader } from "@/components/brand";
import { MERCHANTS } from "@/lib/shop-catalog";

const BEHAVIOUR: Record<string, string> = {
  accepts: "Takes the card and charges the exact total.",
  accepts_with_payment_discount: "Takes the card, then waives shipping at payment, so it charges less than the total.",
  declines_virtual_cards: "Refuses prepaid and virtual cards. Shows the decline, refund and merchant memory.",
};

export default function ShopIndex() {
  return (
    <main className="pb-20">
      <SiteHeader />
      <div className="mx-auto max-w-4xl px-4 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight">Demo shops</h1>
        <p className="mt-2 max-w-2xl text-[var(--muted-foreground)]">
          Three ordinary card-only stores. Agentcard sandbox cards are refused by real merchants, so these shops send payments through a simulated card network that runs
          the issuer&apos;s sandbox charge. They know nothing about crypto.
        </p>
        <ul className="mt-8 divide-y divide-[var(--hairline)] rounded-lg bg-[var(--paper)]">
          {MERCHANTS.map((m) => (
            <li key={m.slug}>
              <Link href={`/shop/${m.slug}`} className="flex items-center justify-between gap-4 p-5 hover:bg-[var(--accent)]">
                <span>
                  <span className="flex items-center gap-2 font-medium">
                    <span className="inline-block h-3 w-3 rounded-full" style={{ background: m.accent }} />
                    {m.name}
                  </span>
                  <span className="mt-1 block text-sm text-[var(--muted-foreground)]">{BEHAVIOUR[m.payment.kind]}</span>
                </span>
                <span className="text-sm text-[var(--carbon)]">Visit</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

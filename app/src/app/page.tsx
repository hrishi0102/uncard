import Link from "next/link";
import { SiteHeader } from "@/components/brand";

const STEPS = [
  {
    title: "Your agent reaches checkout",
    body: "It fills the cart on any site and calls anycheckout_pay with the final total, tax and shipping included.",
  },
  {
    title: "The money is locked, not spent",
    body: "AnyCheckout locks exactly that amount of USDC in your vault on Arc. Inside your weekly allowance there is no wallet pop-up.",
  },
  {
    title: "A single-use card appears",
    body: "Agentcard issues a virtual card for that amount only. The agent types it into the store's card form like a person would.",
  },
  {
    title: "Chainlink settles on the real charge",
    body: "A CRE workflow reads the charge from the card issuer and tells the vault: pay exactly what was charged and return the rest, or refund everything on a decline.",
  },
];

const EXTRAS = [
  ["Pay only what was charged", "Stores often take less than the total. The difference comes straight back to your vault."],
  ["Any token, any chain", "Top up with any token. Uniswap swaps it to USDC and Circle CCTP moves it to Arc."],
  ["A weekly allowance", "Set what the agent may spend without asking. Small buys never interrupt you."],
  ["A human check above the limit", "Bigger purchases wait for you to verify with World ID. The agent cannot do this step."],
  ["Merchant memory", "When a store refuses these cards, every agent learns it and no money gets locked there again."],
  ["One MCP tool for any agent", "Claude, Cursor, your own agent: add one server URL and an agent key."],
];

export default function Home() {
  return (
    <main className="pb-24">
      <SiteHeader />

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-16 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <h1 className="text-[clamp(2.4rem,5.4vw,4.2rem)] leading-[1.02] font-semibold tracking-[-0.02em]">
            Your agent pays by card.
            <br />
            You pay in crypto.
          </h1>
          <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-[var(--muted-foreground)]">
            AnyCheckout is one MCP tool. At checkout your AI agent gets a single-use card for the exact total, funded from your USDC vault on Arc. You only pay what the
            store actually charged.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/dashboard" className="rounded-md bg-[var(--ink)] px-5 py-3 font-medium text-white">
              Open the dashboard
            </Link>
            <Link href="/shop" className="rounded-md border border-[var(--ink)] px-5 py-3 font-medium">
              Try a demo shop
            </Link>
          </div>
          <pre className="mt-8 max-w-[38rem] overflow-x-auto rounded-md bg-[var(--paper)] p-4 font-mono text-[0.8rem] leading-relaxed">
            <span className="text-[var(--muted-foreground)]"># add AnyCheckout to Claude Code</span>
            {"\n"}claude mcp add --transport http anycheckout \{"\n"}  http://localhost:3100/api/mcp \{"\n"}  --header &quot;Authorization: Bearer &lt;agent key&gt;&quot;
          </pre>
        </div>

        <figure aria-label="Example receipt" className="mx-auto w-full max-w-sm">
          <div className="receipt print-in rounded-t-md px-5 pt-5 text-[0.85rem]">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-sans text-base font-semibold">Bandra Gadgets</p>
                <p className="text-[var(--muted-foreground)]">Power bank, USB-C cable</p>
              </div>
              <span className="stamp text-[0.72rem]" style={{ color: "var(--go)" }}>Settled</span>
            </div>
            <hr className="receipt-rule" />
            <div className="flex justify-between text-[var(--muted-foreground)]"><span>Cart total</span><span className="money">$54.48</span></div>
            <div className="flex justify-between"><span>Locked in vault</span><span className="money">$54.48</span></div>
            <div className="flex justify-between"><span>Charged by merchant</span><span className="money">$47.49</span></div>
            <hr className="receipt-rule" />
            <div className="flex justify-between font-semibold"><span>Returned to you</span><span className="money text-[1.1rem]">$6.99</span></div>
            <hr className="receipt-rule" />
            <p className="text-[var(--muted-foreground)]">Card •••• 5876, single use. Free shipping was applied at payment, so the store took less than the total.</p>
          </div>
          <figcaption className="mt-3 text-center text-sm text-[var(--muted-foreground)]">A real run from the local demo.</figcaption>
        </figure>
      </section>

      <section id="how" className="border-y border-[var(--hairline)] bg-[var(--paper)]">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-2xl font-semibold">How one purchase works</h2>
          <ol className="mt-8 grid gap-8 md:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="money text-sm">Step {i + 1}</span>
                <h3 className="mt-1 font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--muted-foreground)]">{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-8 max-w-3xl text-sm text-[var(--muted-foreground)]">
            If the store declines the card or the agent never pays, the card is closed and the whole amount goes back to you. If nothing is reported at all, anyone can
            trigger the refund on-chain once the hold expires.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-2xl font-semibold">More than a crypto-to-card pipe</h2>
        <dl className="mt-8 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
          {EXTRAS.map(([t, b]) => (
            <div key={t}>
              <dt className="font-semibold">{t}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-[var(--muted-foreground)]">{b}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-6xl px-4">
        <div className="rounded-lg bg-[var(--paper)] p-6 text-sm leading-relaxed">
          <h2 className="text-base font-semibold">Built for ETHGlobal Mumbai with</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            <li><strong>Arc</strong>: the USDC escrow vault with allowances, holds and conditional release.</li>
            <li><strong>Chainlink CRE</strong>: reads the card result from the issuer API and writes the settlement on Arc.</li>
            <li><strong>World ID Agent Pass</strong>: the human approval for purchases above your limits.</li>
            <li><strong>Uniswap API</strong>: swaps any token to USDC when you top up.</li>
            <li><strong>Agentcard</strong>: single-use virtual cards with sandbox charges and webhooks.</li>
            <li><strong>Circle CCTP</strong>: moves the swapped USDC to your vault on Arc.</li>
          </ul>
        </div>
      </section>
    </main>
  );
}

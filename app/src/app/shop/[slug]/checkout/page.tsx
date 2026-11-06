"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { use, useState } from "react";
import { merchantBySlug, priceCart } from "@/lib/shop-catalog";
import { usd } from "@/lib/format";
import { useCart } from "../cart";

type Done = { orderId: string; chargedCents: number; listedTotalCents: number; discountCents: number; discountLabel?: string; last4?: string };

export default function Checkout({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const m = merchantBySlug(slug);
  const cart = useCart(slug);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  if (!m) notFound();
  const priced = priceCart(m, cart.items);

  async function pay(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPaying(true);
    const f = new FormData(e.currentTarget);
    try {
      const res = await fetch(`/api/shop/${slug}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.items,
          email: f.get("email"),
          card: { name: f.get("ccname"), number: f.get("cardnumber"), exp: f.get("ccexp"), cvc: f.get("cvc") },
        }),
      });
      const data = await res.json();
      if (!data.ok) setError(data.error ?? "Payment failed");
      else {
        setDone(data);
        cart.clear();
      }
    } catch {
      setError("Network error, try again");
    } finally {
      setPaying(false);
    }
  }

  if (done) {
    return (
      <Frame m={m}>
        <div className="rounded-xl border border-green-600 p-6" role="status">
          <h2 className="text-xl font-semibold text-green-700">Order confirmed</h2>
          <p className="mt-2">
            Order number <strong data-testid="order-id">{done.orderId}</strong>
          </p>
          <p className="mt-1">
            Charged <strong>{usd(done.chargedCents)}</strong> to the card ending {done.last4}.
          </p>
          {done.discountCents > 0 && (
            <p className="mt-1 text-sm text-neutral-600">
              {done.discountLabel}: you saved {usd(done.discountCents)} on the {usd(done.listedTotalCents)} total.
            </p>
          )}
          <Link href={`/shop/${slug}`} className="mt-4 inline-block underline">Continue shopping</Link>
        </div>
      </Frame>
    );
  }

  return (
    <Frame m={m}>
      {cart.ready && priced.lines.length === 0 ? (
        <p>
          Your cart is empty. <Link href={`/shop/${slug}`} className="underline">Browse products</Link>
        </p>
      ) : (
        <div className="grid gap-8 md:grid-cols-[1fr_320px]">
          <form onSubmit={pay} className="space-y-4" aria-label="Payment">
            <h2 className="text-lg font-semibold">Payment</h2>
            <p className="text-sm text-neutral-500">We accept Visa and Mastercard.</p>
            <Field label="Email for the receipt" name="email" type="email" autoComplete="email" defaultValue="agent@anycheckout.dev" />
            <Field label="Name on card" name="ccname" autoComplete="cc-name" required />
            <Field label="Card number" name="cardnumber" autoComplete="cc-number" inputMode="numeric" placeholder="1234 1234 1234 1234" required />
            <div className="grid grid-cols-2 gap-4">
              <Field label="Expiry (MM/YY)" name="ccexp" autoComplete="cc-exp" placeholder="MM/YY" required />
              <Field label="CVC" name="cvc" autoComplete="cc-csc" inputMode="numeric" placeholder="123" required />
            </div>
            {error && (
              <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                {error}
              </p>
            )}
            <button type="submit" disabled={paying || !priced.lines.length} className="w-full rounded-full py-3 font-medium text-white disabled:opacity-60" style={{ background: m.accent }}>
              {paying ? "Processing…" : `Pay ${usd(priced.totalCents)}`}
            </button>
          </form>

          <aside className="h-fit rounded-xl bg-neutral-50 p-5" aria-label="Order summary">
            <h2 className="font-semibold">Order summary</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {priced.lines.map((l) => (
                <li key={l.sku} className="flex justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <span>{l.name}</span>
                    <span className="flex items-center rounded border">
                      <button type="button" aria-label={`One less ${l.name}`} className="px-2" onClick={() => cart.setQty(l.sku, l.qty - 1)}>-</button>
                      <span className="px-1">{l.qty}</span>
                      <button type="button" aria-label={`One more ${l.name}`} className="px-2" onClick={() => cart.setQty(l.sku, l.qty + 1)}>+</button>
                    </span>
                  </span>
                  <span>{usd(l.lineCents)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-4 space-y-1 border-t pt-3 text-sm">
              <div className="flex justify-between"><dt>Subtotal</dt><dd>{usd(priced.subtotalCents)}</dd></div>
              <div className="flex justify-between"><dt>Shipping</dt><dd>{usd(priced.shippingCents)}</dd></div>
              <div className="flex justify-between text-base font-semibold"><dt>Order total</dt><dd data-testid="order-total">{usd(priced.totalCents)}</dd></div>
            </dl>
          </aside>
        </div>
      )}
    </Frame>
  );
}

function Frame({ m, children }: { m: NonNullable<ReturnType<typeof merchantBySlug>>; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-white text-neutral-900">
      <p className="bg-neutral-900 px-4 py-1.5 text-center text-xs text-neutral-300">Demo store for AnyCheckout. Sandbox cards only, nothing real is charged.</p>
      <header className="border-b" style={{ borderColor: m.accent }}>
        <div className="mx-auto max-w-5xl px-4 py-5">
          <Link href={`/shop/${m.slug}`} className="text-2xl font-bold" style={{ color: m.accent }}>{m.name}</Link>
          <p className="text-sm text-neutral-500">Secure checkout</p>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-8">{children}</div>
    </main>
  );
}

function Field({ label, name, ...rest }: { label: string; name: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium">{label}</label>
      <input id={name} name={name} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 outline-none focus:border-neutral-900" {...rest} />
    </div>
  );
}

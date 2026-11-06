"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { use } from "react";
import { merchantBySlug, priceCart } from "@/lib/shop-catalog";
import { usd } from "@/lib/format";
import { useCart } from "./cart";

export default function Store({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const m = merchantBySlug(slug);
  const cart = useCart(slug);
  if (!m) notFound();
  const priced = priceCart(m, cart.items);
  const count = cart.items.reduce((s, i) => s + i.qty, 0);

  return (
    <main className="min-h-dvh bg-white text-neutral-900">
      <p className="bg-neutral-900 px-4 py-1.5 text-center text-xs text-neutral-300">
        Demo store for AnyCheckout. Payments run on sandbox cards, nothing real is charged.{" "}
        <Link href="/shop" className="underline">All demo shops</Link>
      </p>
      <header className="border-b" style={{ borderColor: m.accent }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: m.accent }}>{m.name}</h1>
            <p className="text-sm text-neutral-500">{m.tagline}</p>
          </div>
          <Link href={`/shop/${slug}/checkout`} className="rounded-full px-4 py-2 text-sm font-medium text-white" style={{ background: m.accent }}>
            Cart ({count})
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 py-8" aria-label="Products">
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {m.products.map((p) => (
            <li key={p.sku} className="flex flex-col rounded-xl border border-neutral-200 p-5">
              <div className="grid h-28 place-items-center rounded-lg bg-neutral-50 text-5xl" aria-hidden>{p.emoji}</div>
              <h2 className="mt-4 font-semibold">{p.name}</h2>
              <p className="text-sm text-neutral-500">{p.blurb}</p>
              <div className="mt-auto flex items-center justify-between pt-4">
                <span className="text-lg font-semibold">{usd(p.priceCents)}</span>
                <button
                  type="button"
                  onClick={() => cart.add(p.sku)}
                  className="rounded-full border px-4 py-1.5 text-sm font-medium hover:bg-neutral-50"
                  style={{ borderColor: m.accent, color: m.accent }}
                  aria-label={`Add ${p.name} to cart`}
                >
                  Add to cart
                </button>
              </div>
            </li>
          ))}
        </ul>

        {count > 0 && (
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-neutral-50 p-5">
            <p>
              {count} item{count > 1 ? "s" : ""}, subtotal <strong>{usd(priced.subtotalCents)}</strong>
            </p>
            <Link href={`/shop/${slug}/checkout`} className="rounded-full px-5 py-2.5 font-medium text-white" style={{ background: m.accent }}>
              Go to checkout
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}

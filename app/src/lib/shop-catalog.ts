/**
 * Mock merchants for the demo. Agentcard sandbox cards can't be charged by real stores,
 * so these three shops run their payments through a simulated card network that calls
 * the issuer's sandbox charge endpoints (test_charge / test_authorization).
 */

export type Product = { sku: string; name: string; priceCents: number; blurb: string; emoji: string };

export type Merchant = {
  slug: string;
  name: string;
  domain: string;
  tagline: string;
  mcc: string;
  shippingCents: number;
  accent: string; // tailwind-free hex for a small brand touch
  /** How this store's payment processor treats single-use virtual cards. */
  payment:
    | { kind: "accepts" }
    | { kind: "accepts_with_payment_discount"; label: string; discountCents: (subtotal: number, shipping: number) => number }
    | { kind: "declines_virtual_cards"; declineReason: string };
  products: Product[];
};

export const MERCHANTS: Merchant[] = [
  {
    slug: "chai-co",
    name: "Chai & Co. Mumbai",
    domain: "chai-co.anycheckout.dev",
    tagline: "Small-batch masala chai, roasted in Colaba",
    mcc: "5499",
    shippingCents: 499,
    accent: "#b45309",
    payment: { kind: "accepts" },
    products: [
      { sku: "chai-tin", name: "Masala Chai Tin (250g)", priceCents: 1400, blurb: "Assam CTC, cardamom, ginger, clove", emoji: "🫖" },
      { sku: "biscuits", name: "Cardamom Nankhatai", priceCents: 650, blurb: "Butter biscuits, box of 12", emoji: "🍪" },
      { sku: "kettle", name: "Brass Chai Kettle", priceCents: 3200, blurb: "Hand-hammered, 1 litre", emoji: "☕" },
    ],
  },
  {
    slug: "bandra-gadgets",
    name: "Bandra Gadgets",
    domain: "bandra-gadgets.anycheckout.dev",
    tagline: "Audio and accessories, delivered same day",
    mcc: "5732",
    shippingCents: 699,
    accent: "#4f46e5",
    payment: {
      kind: "accepts_with_payment_discount",
      label: "Free shipping on card orders over $40, applied when the card is charged",
      discountCents: (subtotal, shipping) => (subtotal >= 4000 ? shipping : 0),
    },
    products: [
      { sku: "headphones", name: "Noise-Cancelling Headphones", priceCents: 17900, blurb: "40h battery, ANC, foldable", emoji: "🎧" },
      { sku: "powerbank", name: "20,000 mAh Power Bank", priceCents: 3450, blurb: "65W USB-C PD", emoji: "🔋" },
      { sku: "cable", name: "Braided USB-C Cable (2m)", priceCents: 1299, blurb: "100W, lifetime warranty", emoji: "🔌" },
    ],
  },
  {
    slug: "fortress-electronics",
    name: "Fortress Electronics",
    domain: "fortress-electronics.anycheckout.dev",
    tagline: "Keyboards and mice for serious desks",
    mcc: "5732",
    shippingCents: 500,
    accent: "#0f766e",
    payment: { kind: "declines_virtual_cards", declineReason: "prepaid_card_not_accepted" },
    products: [
      { sku: "keyboard", name: "Mechanical Keyboard (75%)", priceCents: 8900, blurb: "Hot-swap, gasket mount", emoji: "⌨️" },
      { sku: "mouse", name: "Wireless Mouse", priceCents: 2900, blurb: "26k DPI, 70g", emoji: "🖱️" },
    ],
  },
];

export const merchantBySlug = (slug: string) => MERCHANTS.find((m) => m.slug === slug);

export function priceCart(m: Merchant, items: { sku: string; qty: number }[]) {
  const lines = items
    .map((it) => {
      const p = m.products.find((x) => x.sku === it.sku);
      const qty = Math.max(0, Math.min(20, Math.floor(it.qty)));
      return p && qty > 0 ? { ...p, qty, lineCents: p.priceCents * qty } : null;
    })
    .filter((x): x is Product & { qty: number; lineCents: number } => Boolean(x));
  const subtotalCents = lines.reduce((s, l) => s + l.lineCents, 0);
  const shippingCents = lines.length ? m.shippingCents : 0;
  return { lines, subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

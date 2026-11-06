import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { merchantBySlug, priceCart } from "@/lib/shop-catalog";
import { chargeCard } from "@/server/card-network";

export const dynamic = "force-dynamic";

const body = z.object({
  items: z.array(z.object({ sku: z.string(), qty: z.number() })).min(1),
  card: z.object({ number: z.string(), exp: z.string(), cvc: z.string(), name: z.string().optional() }),
  email: z.string().optional(),
});

/** The mock merchant's own payment endpoint. It knows nothing about AnyCheckout: it just charges a card. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ merchant: string }> }) {
  const { merchant: slug } = await ctx.params;
  const m = merchantBySlug(slug);
  if (!m) return NextResponse.json({ ok: false, error: "Unknown shop" }, { status: 404 });
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Please fill in every card field" }, { status: 400 });

  const cart = priceCart(m, parsed.data.items);
  if (!cart.lines.length) return NextResponse.json({ ok: false, error: "Your cart is empty" }, { status: 400 });
  const [mm, yy] = parsed.data.card.exp.split("/").map((s) => s.trim());
  const discount = m.payment.kind === "accepts_with_payment_discount" ? m.payment.discountCents(cart.subtotalCents, cart.shippingCents) : 0;
  const amountCents = cart.totalCents - discount;

  const result = await chargeCard({
    number: parsed.data.card.number,
    expMonth: mm ?? "",
    expYear: yy ?? "",
    cvc: parsed.data.card.cvc,
    amountCents,
    merchant: m.name.toUpperCase(),
    mcc: m.mcc,
    declineReason: m.payment.kind === "declines_virtual_cards" ? m.payment.declineReason : undefined,
  });

  if (!result.approved) {
    const friendly: Record<string, string> = {
      prepaid_card_not_accepted: "This store does not accept prepaid or virtual cards.",
      insufficient_funds: "Card declined: insufficient funds.",
      invalid_card_details: "Card declined: the card details are not valid.",
      invalid_card_number: "Card declined: invalid card number.",
      card_not_open: "Card declined: this card was already used or closed.",
    };
    return NextResponse.json({ ok: false, error: friendly[result.reason] ?? `Card declined (${result.reason}).`, reason: result.reason }, { status: 402 });
  }
  const orderId = `${m.slug.slice(0, 3).toUpperCase()}-${Math.floor(100000 + Math.random() * 900000)}`;
  return NextResponse.json({
    ok: true,
    orderId,
    chargedCents: amountCents,
    listedTotalCents: cart.totalCents,
    discountCents: discount,
    discountLabel: discount ? (m.payment.kind === "accepts_with_payment_discount" ? m.payment.label : undefined) : undefined,
    last4: result.last4,
  });
}

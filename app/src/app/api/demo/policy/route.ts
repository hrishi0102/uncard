import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { demoSetPolicy } from "@/server/chain";

export const dynamic = "force-dynamic";

/** Local chain only: sign setPolicy as the demo user (on testnet the user signs in their wallet). */
export async function POST(req: NextRequest) {
  const p = z
    .object({ weekly: z.number().min(0).max(100000), perPurchase: z.number().min(0).max(100000), enabled: z.boolean() })
    .safeParse(await req.json());
  if (!p.success) return NextResponse.json({ error: "bad input" }, { status: 400 });
  try {
    const tx = await demoSetPolicy(Math.round(p.data.weekly * 100), Math.round(p.data.perPurchase * 100), p.data.enabled);
    return NextResponse.json({ tx });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

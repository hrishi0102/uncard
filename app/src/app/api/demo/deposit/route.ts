import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { demoFaucetAndDeposit } from "@/server/chain";

export const dynamic = "force-dynamic";

/** Local chain only: mint mock USDC to the demo user and deposit it into the vault. */
export async function POST(req: NextRequest) {
  const p = z.object({ amount: z.number().positive().max(100000) }).safeParse(await req.json());
  if (!p.success) return NextResponse.json({ error: "bad input" }, { status: 400 });
  try {
    const tx = await demoFaucetAndDeposit(Math.round(p.data.amount * 100));
    return NextResponse.json({ tx });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

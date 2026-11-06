import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { claimBridgedDeposit, claimStatus } from "@/server/cctp";

export const dynamic = "force-dynamic";

const body = z.object({ sourceDomain: z.number().int(), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

/** Start relaying a CCTP burn into the Arc vault (returns at once; poll with GET). */
export async function POST(req: NextRequest) {
  const p = body.safeParse(await req.json());
  if (!p.success) return NextResponse.json({ error: "sourceDomain and txHash are required" }, { status: 400 });
  after(() => claimBridgedDeposit(p.data.sourceDomain, p.data.txHash).then(() => undefined));
  return NextResponse.json({ status: "waiting_for_attestation" });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  return NextResponse.json(claimStatus(Number(sp.get("sourceDomain")), sp.get("txHash") ?? "") ?? { status: "unknown" });
}

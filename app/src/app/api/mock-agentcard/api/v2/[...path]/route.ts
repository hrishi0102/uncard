import { after, NextRequest, NextResponse } from "next/server";
import { handleMock, MockHttpError } from "@/server/mock-agentcard";

export const dynamic = "force-dynamic";

async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const ct = req.headers.get("content-type") ?? "";
  let body: Record<string, unknown> | URLSearchParams | null = null;
  if (req.method !== "GET") {
    const raw = await req.text();
    if (ct.includes("application/x-www-form-urlencoded")) body = new URLSearchParams(raw);
    else if (raw) body = JSON.parse(raw);
  }
  try {
    const res = await handleMock(req.method, path, req.headers, body, req.nextUrl.searchParams);
    if (res.after) after(res.after);
    return NextResponse.json(res.body, { status: res.status });
  } catch (e) {
    if (e instanceof MockHttpError) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message, docs: "https://docs.agentcard.com" } },
        { status: e.status },
      );
    }
    console.error("[mock-agentcard]", e);
    return NextResponse.json({ error: { code: "internal", message: (e as Error).message } }, { status: 500 });
  }
}

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };

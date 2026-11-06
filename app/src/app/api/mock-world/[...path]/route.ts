import { NextRequest, NextResponse } from "next/server";
import { decide, deviceAuthorization, discoveryDoc, jwks, lookup, PERSONAS, token } from "@/server/mock-world";

export const dynamic = "force-dynamic";

async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const route = `${req.method} /${path.join("/")}`;

  if (route === "GET /.well-known/openid-configuration") return NextResponse.json(discoveryDoc());
  if (route === "GET /.well-known/jwks.json") return NextResponse.json(await jwks());
  if (route === "GET /device/lookup") {
    const info = lookup(req.nextUrl.searchParams.get("user_code") ?? "");
    return info ? NextResponse.json(info) : NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (route === "POST /device/decide") {
    const b = (await req.json()) as { user_code: string; decision: "approve" | "deny"; persona?: keyof typeof PERSONAS };
    const r = await decide(b.user_code, b.decision, b.persona ?? "owner");
    return NextResponse.json(r, { status: r.ok ? 200 : 404 });
  }
  if (req.method === "POST" && (route === "POST /api/v1/device_authorization" || route === "POST /api/v1/token")) {
    const form = new URLSearchParams(await req.text());
    // support client_secret_basic as well
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(auth.slice(6), "base64").toString().split(":").map(decodeURIComponent);
      form.set("client_id", id);
      form.set("client_secret", secret);
    }
    const r = route.endsWith("device_authorization") ? await deviceAuthorization(form) : await token(form);
    return NextResponse.json(r.body, { status: r.status });
  }
  return NextResponse.json({ error: "not_found", route }, { status: 404 });
}

export { handler as GET, handler as POST };

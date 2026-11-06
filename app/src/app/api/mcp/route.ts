import { NextRequest, NextResponse } from "next/server";
import { handleMcpMessage } from "@/server/mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

function bearer(req: NextRequest) {
  const h = req.headers.get("authorization");
  return h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS });
  }
  const key = bearer(req);
  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = (await Promise.all(messages.map((m) => handleMcpMessage(m, key)))).filter(Boolean);
  if (responses.length === 0) return new NextResponse(null, { status: 202, headers: CORS });
  return NextResponse.json(Array.isArray(payload) ? responses : responses[0], { headers: CORS });
}

// Stateless server: no server-initiated SSE stream, no sessions to delete.
export async function GET() {
  return new NextResponse("Method Not Allowed", { status: 405, headers: { ...CORS, Allow: "POST" } });
}
export async function DELETE() {
  return new NextResponse(null, { status: 405, headers: CORS });
}
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

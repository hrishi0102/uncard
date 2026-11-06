# MCP server

Code: `app/src/server/mcp.ts` (protocol and tools), `app/src/app/api/mcp/route.ts` (HTTP).

This is the only thing an agent needs. Any MCP client (Claude Code, Claude Desktop through `mcp-remote`, Cursor, a custom agent) connects to one URL with an agent key.

## Transport

- MCP Streamable HTTP, **stateless**: every request is a POST with a JSON-RPC message or a batch. No sessions, no server-sent stream.
- Notifications get `202` with no body. `GET` and `DELETE` return `405`.
- Methods: `initialize` (picks the newest version both sides support from `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and returns usage instructions), `tools/list`, `tools/call`, `ping`.
- Auth: `Authorization: Bearer <agent key>`. The key maps to a user (`userByAgentKey`). The local demo key is `ak_demo_local_only_change_me`.
- CORS is open so browser-based agents can call it.

## Tools

| Tool | What it does |
|---|---|
| `anycheckout_pay` | Inputs: merchant name and URL, final total in USD, description, optional idempotency key. Returns `card_issued` with the card details, or `needs_approval` with an `approval_url`, or a rejection with reasons |
| `anycheckout_get_card` | Card number, expiry and CVC for a checkout that is `card_issued`. Read right before typing it |
| `anycheckout_status` | State, amounts, and the Arc settlement tx |
| `anycheckout_balance` | Vault balance, weekly amount left, per-purchase limit |
| `anycheckout_check_merchant` | Whether a store is known to accept or decline these cards |

Results come back both as JSON text and as `structuredContent`. Tool annotations mark which tools are read-only.

## Decisions

- **Hand-rolled JSON-RPC instead of the SDK.** The surface is small, it fits a Next.js route handler without an adapter, and stateless mode is easy to reason about. Checked against the official MCP Inspector CLI.
- **`anycheckout_pay` returns the card at once when it is ready**, so the common case is one tool call. `anycheckout_get_card` exists for after an approval.
- **The agent never sees World's device code.** It only gets an approval link meant for the human.
- **Plain English in tool descriptions and instructions.** The model reads them to decide what to do, so they say when to call each tool and what each status means.

# Key decisions

Newest at the bottom. Add a line here whenever a choice changes how a module works. Format: date, the decision, why, and what it affects.

## 2026-11-05: Agentcard Issuing, not Vault or the Commerce SDK

Vault and the Commerce SDK both pay with the user's own card. We need a new card funded by crypto, and only Issuing does that (company-funded cards, funds held as USDC). Affects [card-issuing.md](card-issuing.md).

## 2026-11-05: One MCP server as the product surface

Any agent (Claude Code, Claude Desktop, Cursor, a custom one) can use it with a URL and a key. No SDK per agent. Stateless Streamable HTTP, hand-rolled. Affects [mcp.md](mcp.md).

## 2026-11-05: Sponsors: Arc, Chainlink CRE, World ID Agent Pass, Uniswap API

Each one does a real job in the flow: Arc holds the money, CRE settles on the real card result, World is the human check, Uniswap brings any token in. Arc prizes need an Arc Studio project, so the vault is a single file with no imports. Affects [contracts.md](contracts.md).

## 2026-11-05: Weekly allowance signed once, enforced on-chain

The user signs `setPolicy` once. The operator then opens holds with no wallet pop-up, and the vault enforces the limits itself. Over the limits needs a human. Affects [contracts.md](contracts.md), [backend.md](backend.md).

## 2026-11-05: Settle the exact charged amount, refund the rest

Stores often charge less than the total (discounts at payment, shipping waived). Locking the total and paying only the cleared amount is the core promise. Affects [settlement.md](settlement.md).

## 2026-11-05: Bind each hold to one card (`cardRef`)

The card is created first and its id hash is stored in the hold. CRE refuses to settle a hold with any other card's data. Affects [contracts.md](contracts.md), [settlement.md](settlement.md).

## 2026-11-05: Mocks that copy the real wire formats

Agentcard sign-ups are invite-only, World needs a developer portal client, CRE needs `cre login`. Instead of fake interfaces, the mocks serve the same HTTP APIs (paths, payloads, errors, signed webhooks, RS256 tokens), so going real is env only. Affects [card-issuing.md](card-issuing.md), [human-approval.md](human-approval.md), [local-dev.md](local-dev.md).

## 2026-11-05: Testnets and sandbox only

Demo, no paid plans, no real purchases. Demo shops run on a simulated card network that calls the issuer's sandbox charge endpoints.

## 2026-11-05: Next.js for both UI and backend, JSON file store

One process, one deploy, light stack. The store is a JSON file because V1 has one user. Replace `store.ts` when multi-user lands. Affects [backend.md](backend.md).

## 2026-11-06: Wait while the card is open; close the card on decline

A refund while the card was still open allowed a later charge to succeed after the money was returned. Now settlement waits until the card is closed or charged, and the backend closes the card on a decline. Affects [settlement.md](settlement.md), [backend.md](backend.md).

## 2026-11-06: Single-flight locks and a hot-reload-safe loop

Fixes two races seen in testing: a World device code redeemed twice, and a stale dev timer settling the same hold twice. Affects [backend.md](backend.md), [human-approval.md](human-approval.md).

## 2026-11-06: App on port 3100

Another project in the parent folder uses 3000. Affects [local-dev.md](local-dev.md).

## 2026-11-06: No README for now

The `architecture/` folder is the project documentation until a README is wanted.

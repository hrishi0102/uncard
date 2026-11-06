# AnyCheckout

**Your AI agent pays by card on any website. You pay in crypto, and only what was charged.**

AnyCheckout is one MCP tool. When your agent reaches a checkout, it calls `anycheckout_pay` with the final total. AnyCheckout locks that exact amount of USDC in your vault on Arc, hands the agent a single-use virtual card (Agentcard) for that amount, and a Chainlink CRE workflow settles on the real card result: it pays exactly what the store charged and returns the rest, or refunds everything on a decline or timeout.

Built at ETHGlobal Mumbai (5 to 7 Nov 2026).

```
agent: anycheckout_pay $54.48 -> card_issued, card •••• 4320
shop:  order BAN-828502, charged $47.49            (store waived shipping at payment)
vault: settled: charged $47.49, returned $6.99      (on-chain, via the settlement report)
```

## What makes it more than a crypto-to-card pipe

| | |
|---|---|
| **Pay only what was charged** | Stores often take less than the total. The vault pays the exact cleared amount and sends the rest back. |
| **Any token, any chain** | Top up with any token. The Uniswap API swaps it to USDC, Circle CCTP V2 mints it straight into the vault on Arc. |
| **A weekly allowance** | One `setPolicy` signature. After that the agent never needs a wallet pop-up for purchases inside the limits. |
| **A human check above the limit** | Bigger purchases pause for a World ID Agent Pass step-up. The agent cannot do this step itself. |
| **Merchant memory** | When a store refuses these cards, it is remembered, and no agent locks money there again. |
| **One MCP tool for any agent** | Claude Code, Claude Desktop, Cursor, or your own agent: one URL and an agent key. |

## How one purchase flows

```mermaid
sequenceDiagram
    autonumber
    participant A as AI agent
    participant M as AnyCheckout MCP + backend
    participant V as AnyCheckoutVault (Arc)
    participant C as Agentcard (Issuing API)
    participant S as Any card checkout
    participant W as World ID Agent Pass
    participant R as Chainlink CRE workflow
    A->>M: anycheckout_pay(merchant, total)
    M->>V: read policy (balance, weekly left, per-purchase limit)
    alt above the limits
        M-->>A: needs_approval + approval_url
        A-->>W: human opens link, verifies (device flow)
        W-->>M: ID token (validated: JWKS, iss, aud, auth_time, acr, linked sub)
    end
    M->>C: create single-use card for exactly the total
    M->>V: openHold(holdId, user, amount, cardRef = hash(cardId))  no user signature
    M-->>A: card number, expiry, CVC
    A->>S: types the card, pays
    S->>C: charge (sandbox: test_charge / test_authorization)
    C-->>M: webhook transaction.cleared / declined (signed)
    M->>R: HTTP trigger {holdId, cardId}
    R->>V: EVM read getHold: open? cardRef matches?
    R->>C: read card + transactions (every node, identical consensus)
    R->>V: signed report -> forwarder -> onReport(SETTLE charged | REFUND)
    V-->>V: pay charged to treasury, return the rest to the user
```

If nothing is reported, the backend closes the unused card and refunds, and after `ttl + grace` **anyone** can call `expireHold` on-chain for a full refund.

## Run it locally (no keys needed)

Everything runs on a local chain with a mock card issuer and a mock World IdP that implement the same APIs as the real ones. Needs Node 22+, Foundry, and Bun (only for the CRE workflow).

```bash
npm --prefix app install
```

```bash
npm run chain                 # terminal 1: anvil on :8545
```

```bash
npm run local:setup           # deploys the vault, seeds a demo user with 500 USDC, writes app/.env.local
```

```bash
npm run dev                   # terminal 2: app on http://localhost:3100
```

```bash
npm run demo:agent            # a scripted agent runs all 5 scenarios through MCP
```

Then open http://localhost:3100/dashboard and http://localhost:3100/shop.

The scripted agent covers: partial charge (pay $47.49 of $54.48), decline + full refund + merchant memory, a purchase above the limit approved with World ID, the same purchase denied, and an abandoned checkout.

### Connect a real agent

The dashboard shows your MCP URL and agent key with copy buttons.

```bash
claude mcp add --transport http anycheckout http://localhost:3100/api/mcp --header "Authorization: Bearer ak_demo_local_only_change_me"
```

Claude Desktop (stdio bridge):

```json
{ "mcpServers": { "anycheckout": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3100/api/mcp", "--header", "Authorization: Bearer ak_demo_local_only_change_me"] } } }
```

Then ask your agent (with a browser tool) something like: *"Buy a masala chai tin and biscuits from http://localhost:3100/shop/chai-co and pay with AnyCheckout."*

MCP tools: `anycheckout_pay`, `anycheckout_get_card`, `anycheckout_status`, `anycheckout_balance`, `anycheckout_check_merchant`.

## Sponsor integrations (where to look)

### Arc: conditional USDC escrow ([contracts/src/AnyCheckoutVault.sol](contracts/src/AnyCheckoutVault.sol))
- Weekly allowance + per-purchase limit + kill switch: `setPolicy` [L264](contracts/src/AnyCheckoutVault.sol#L264), enforced in `openHold` [L329](contracts/src/AnyCheckoutVault.sol#L329)
- Hold bound to one card (`cardRef`) and optional World ID approval (`approvalRef`): `HoldRequest` [L316](contracts/src/AnyCheckoutVault.sol#L316)
- Multi-step settlement: `_settle` pays exactly the charged amount and returns the rest [L512](contracts/src/AnyCheckoutVault.sol#L512), `_refund` [L534](contracts/src/AnyCheckoutVault.sol#L534)
- Automatic release: `expireHold` lets anyone refund after ttl + grace [L413](contracts/src/AnyCheckoutVault.sol#L413)
- Crosschain deposits: `claimBridgedDeposit` mints CCTP V2 USDC into the vault and credits the depositor [L277](contracts/src/AnyCheckoutVault.sol#L277)
- Uses only the USDC ERC-20 interface (6 decimals), never `msg.value` (Arc's native USDC has 18). 23 Foundry tests: [contracts/test/AnyCheckoutVault.t.sol](contracts/test/AnyCheckoutVault.t.sol)
- Single file with no imports on purpose, so it can be brought into Arc Studio as is: see [docs/ARC_STUDIO.md](docs/ARC_STUDIO.md)

### Chainlink CRE: settlement on the real charge ([cre/settlement/main.ts](cre/settlement/main.ts))
- HTTP trigger handler [L115](cre/settlement/main.ts#L115)
- EVM read of the hold, checks `cardRef == keccak256(cardId)` [L126](cre/settlement/main.ts#L126)
- Agentcard API read on every node with identical consensus [L78](cre/settlement/main.ts#L78)
- Signed report [L169](cre/settlement/main.ts#L169) and `writeReport` to the vault on `arc-testnet` [L172](cre/settlement/main.ts#L172)
- Consumer side: `onReport` with forwarder and optional workflow id/owner checks [contracts L384](contracts/src/AnyCheckoutVault.sol#L384)
- Same rules as the backend's local mode, unit tested: [cre/settlement/logic.ts](cre/settlement/logic.ts), `bun test` (7 tests). Compiles to WASM with `cre-compile`.

### World ID Agent Pass: the human check ([app/src/server/world.ts](app/src/server/world.ts))
- Device Authorization Grant (World's documented flow for headless agents) with an essential `acr` claim [L69](app/src/server/world.ts#L69)
- Token polling with the exact stop rules (pending, slow_down, access_denied, expired_token, 503) [L92](app/src/server/world.ts#L92)
- Backend validation: JWKS signature, iss, aud, exp, `auth_time` freshness for this attempt, accepted `acr` [L125](app/src/server/world.ts#L125)
- Binding: first approval links `(iss, sub)` to the vault, later ones must match; one-use approval tied to this exact purchase via `approvalRef` [app/src/server/intents.ts L296](app/src/server/intents.ts#L296), [L349](app/src/server/intents.ts#L349)
- Denied, cancelled, expired and wrong-person paths all leave nothing locked and no card issued
- Debrief: [docs/WORLD_DEBRIEF.md](docs/WORLD_DEBRIEF.md)

### Uniswap: any token in ([app/src/server/uniswap.ts](app/src/server/uniswap.ts))
- `/check_approval` [L68](app/src/server/uniswap.ts#L68), `/quote` as `EXACT_OUTPUT` so you get exactly the USDC you asked for [L78](app/src/server/uniswap.ts#L78), `/swap` [L94](app/src/server/uniswap.ts#L94)
- Wallet flow with Permit2 signature and swap tx: [app/src/app/topup/page.tsx L163](app/src/app/topup/page.tsx#L163)
- Then CCTP V2 burn to the vault: [L189](app/src/app/topup/page.tsx#L189), relayed by [app/src/server/cctp.ts](app/src/server/cctp.ts)
- Feedback: [FEEDBACK.md](FEEDBACK.md)

### Agentcard: single-use cards ([app/src/server/agentcard.ts](app/src/server/agentcard.ts))
- Issuing API v2: OAuth client credentials, `POST /cards` with `Idempotency-Key` = intent id [L137](app/src/server/agentcard.ts#L137), credentials at checkout time, close, transactions
- Signed webhooks (`AgentCard-Signature`, HMAC over `t.body`) [L177](app/src/server/agentcard.ts#L177)
- Sandbox charges for the demo shops: `test_charge`, `test_authorization` [L159](app/src/server/agentcard.ts#L159)
- Why Issuing and not Vault or the Commerce SDK: both of those pay with the user's own card (Vault stores it behind a passkey, the Commerce SDK buys at a fixed set of merchants with that Vault card). AnyCheckout needs a new card funded by crypto, which is exactly what Issuing does (company-funded cards, "funds held in USDC on Base").

## Status: what is real and what is mocked

| Piece | Local demo | With keys (see [docs/MORNING.md](docs/MORNING.md)) |
|---|---|---|
| Vault on Arc | anvil, same contract | Arc Testnet via `scripts/deploy-arc.sh` |
| Card issuer | `/api/mock-agentcard`: same REST paths, payloads, errors and signed webhooks as `api.agentcard.sh` | Agentcard sandbox (`CARD_ISSUER=agentcard`). Sign-up is invite-only, so not done yet |
| Settlement | backend writes the same report through a `LocalForwarder` | `cre workflow simulate --broadcast` against the vault on Arc Testnet |
| Human check | `/api/mock-world`: OIDC discovery, JWKS, device flow, real RS256 tokens | World ID Agent Pass sandbox (`WORLD_MODE=sandbox`) |
| Any-token top-up | needs a Uniswap API key | Base Sepolia (Uniswap API) then CCTP to Arc |
| Merchants | 3 demo shops on a simulated card network that calls the issuer's sandbox charge API | same (sandbox cards are refused by real merchants) |

Not built yet (honest list): multi-user sign-in (V1 has one demo user), RFC 9470 challenge for MCP clients, verifying the World approval on-chain (today the operator attests it via `approvalRef`; CRE could verify it next), treasury rebalancing from Arc back to the Agentcard company wallet.

## Repo map

```
contracts/   Foundry: AnyCheckoutVault + local mocks + tests + deploy script
app/         Next.js 15: MCP endpoint, backend, dashboard, approval page, demo shops, top-up
cre/         Chainlink CRE project: settlement workflow (TypeScript -> WASM)
scripts/     local-setup.sh, demo-agent.mjs, deploy-arc.sh, agentcard-setup.mjs
docs/        MORNING.md (keys checklist), ARC_STUDIO.md, WORLD_DEBRIEF.md, DEMO_SCRIPT.md
```

## Limits for a real launch

Agentcard Issuing today: no cards for people in India, ID checks for every user, a $5,000 monthly cap, and terms that bar running it for other people. Sandbox cards don't work on real sites, which is why the demo uses its own shops. This repo is a testnet demo only.

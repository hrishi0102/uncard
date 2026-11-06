# Overview

AnyCheckout lets an AI agent pay on any website that takes cards, while the user pays in crypto, and only pays what the store actually charged.

The agent calls one MCP tool with the final total. The backend locks that exact amount of USDC in the user's vault on Arc and gets a single-use virtual card from Agentcard for the same amount. The agent types the card into checkout. When the card result comes in, a settlement report pays exactly the charged amount and returns the rest. A decline, an unused card or a timeout returns everything.

Built for ETHGlobal Mumbai (5 to 7 Nov 2026). Testnets and sandbox cards only.

## How these docs work

Each file covers one module: what it does, where the code is, and the decisions behind it. When you change a module, update its file in the same commit. Big choices also go in [decisions.md](decisions.md) with the date and the reason.

| File | Covers |
|---|---|
| [overview.md](overview.md) | This page: the big picture, the repo map, one purchase end to end |
| [contracts.md](contracts.md) | `AnyCheckoutVault` on Arc: balances, policy, holds, settlement, CCTP deposits |
| [backend.md](backend.md) | The checkout lifecycle in the Next.js server: intents, store, chain client, reconcile loop |
| [mcp.md](mcp.md) | The MCP server the agent talks to |
| [card-issuing.md](card-issuing.md) | Agentcard Issuing client, the mock issuer, the demo shops and card network |
| [human-approval.md](human-approval.md) | World ID Agent Pass step-up for purchases above the limits |
| [settlement.md](settlement.md) | The settlement rules and the Chainlink CRE workflow |
| [top-up.md](top-up.md) | Any-token top-up: Uniswap Trading API swap, then CCTP V2 into the vault |
| [frontend.md](frontend.md) | Pages: dashboard, approval page, demo shops, top-up, design system |
| [local-dev.md](local-dev.md) | Running everything locally, env vars, scripts, what is mocked |
| [decisions.md](decisions.md) | Log of key decisions and why |

## Repo map

```
contracts/   Foundry project: AnyCheckoutVault, local-only mocks, tests, deploy script
app/         Next.js 15 app: MCP endpoint, backend, dashboard, approval page, demo shops, top-up
cre/         Chainlink CRE project: the settlement workflow (TypeScript compiled to WASM)
scripts/     local-setup.sh, demo-agent.mjs, deploy-arc.sh, agentcard-setup.mjs, export-abi.mjs
docs/        Hackathon working notes: keys checklist, Arc Studio prompt, World debrief, demo script
architecture/ These docs
```

## The parts and who talks to whom

```mermaid
flowchart LR
    Agent[AI agent] -- MCP over HTTP --> MCP[MCP endpoint /api/mcp]
    MCP --> Intents[Intent lifecycle<br/>app/src/server/intents.ts]
    Intents -- openHold, cancel, expire --> Vault[(AnyCheckoutVault<br/>Arc)]
    Intents -- create card, credentials, close --> Issuer[Agentcard Issuing API<br/>or local mock]
    Issuer -- signed webhooks --> Webhook[/api/webhooks/agentcard/]
    Webhook --> Intents
    Intents -- HTTP trigger --> CRE[Chainlink CRE workflow]
    CRE -- read hold --> Vault
    CRE -- read card + transactions --> Issuer
    CRE -- signed report via forwarder --> Vault
    Intents -- device flow --> World[World ID IdP<br/>or local mock]
    Human[User] -- approve in World App --> World
    Human -- top up --> TopUp[Top-up page]
    TopUp -- swap --> Uniswap[Uniswap Trading API]
    TopUp -- CCTP burn --> CCTP[Circle CCTP V2]
    CCTP -- relayer claims --> Vault
    Agent -- types card --> Shop[Any card checkout]
    Shop -- charge --> Issuer
```

## One purchase, step by step

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
    M->>M: merchant memory check
    M->>V: read policy (balance, weekly left, per-purchase limit)
    alt above the limits
        M-->>A: needs_approval + approval_url
        A-->>W: human opens link, verifies (device flow)
        W-->>M: ID token (JWKS, iss, aud, auth_time, acr, linked sub)
    end
    M->>C: create single-use card for exactly the total
    M->>V: openHold(holdId, user, amount, cardRef = hash(cardId)), no user signature
    M-->>A: card number, expiry, CVC
    A->>S: types the card, pays
    S->>C: charge
    C-->>M: webhook transaction.cleared or declined (signed)
    M->>R: HTTP trigger {holdId, cardId}
    R->>V: read getHold: open? cardRef matches?
    R->>C: read card + transactions (identical consensus)
    R->>V: report through forwarder: onReport(SETTLE charged | REFUND)
    V-->>V: pay charged to treasury, return the rest to the user
```

If no result ever arrives, the backend closes the unused card and refunds. After `expiresAt + settlementGrace` anyone can call `expireHold` on-chain for a full refund, so money can never get stuck.

## Sponsor map

| Sponsor | What it does here | Main code |
|---|---|---|
| Arc | The escrow vault and the USDC it holds | `contracts/src/AnyCheckoutVault.sol` |
| Chainlink CRE | Reads the real card result and writes settle or refund on-chain | `cre/settlement/main.ts` |
| World ID Agent Pass | The human check above the agent's limits | `app/src/server/world.ts` |
| Uniswap API | Swaps any token to USDC for top-ups | `app/src/server/uniswap.ts`, `app/src/app/topup/page.tsx` |
| Agentcard | The single-use virtual cards | `app/src/server/agentcard.ts` |
| Circle CCTP V2 | Moves the swapped USDC to Arc, straight into the vault | `app/src/server/cctp.ts`, `claimBridgedDeposit` in the vault |

## Known gaps (V1)

- One demo user. No sign-in yet.
- Above-limit approvals are checked by the backend and recorded on-chain as `approvalRef`, but the vault does not verify them itself.
- No RFC 9470 step-up challenge for MCP clients. The agent gets an `approval_url` instead.
- No treasury rebalancing from Arc back to the Agentcard company wallet.
- Agentcard Issuing limits for a real launch: no cards for people in India, ID checks for every user, a $5,000 monthly cap, and terms that bar running it for other people.

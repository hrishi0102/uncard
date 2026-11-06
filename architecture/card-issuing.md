# Card issuing: Agentcard, the mock issuer, the demo shops

## Agentcard client (`app/src/server/agentcard.ts`)

Talks to the Agentcard Issuing API v2 (`https://api.agentcard.sh/api/v2`).

- Auth: OAuth client credentials at `/oauth/token`, token cached until it expires.
- Sandbox onboarding: `/connect/start`, `/connect/verify` (sandbox code `111111`), `/connect/consent`, `/kyc/simulate`, `/company_wallet/test_fund`. Used by `users.ts` and `scripts/agentcard-setup.mjs`.
- Cards: `POST /cards` with `Idempotency-Key` = intent id (handles `202 funding_in_progress` by retrying), `GET /cards/{id}`, `/credentials`, `/close`.
- `GET /transactions?card_id=`.
- Sandbox charges: `/test_charge` and `/test_authorization` (outcome `declined`).
- Webhooks: `AgentCard-Signature: t=...,v1=hmac_sha256(secret, "${t}.${rawBody}")`. `verifyWebhookSignature` checks it with a time tolerance. Events used: `transaction.authorized`, `transaction.cleared`, `transaction.declined`, `card.closed`.
- `AgentcardError` keeps the API's status and error code.

## Mock issuer (`app/src/server/mock-agentcard.ts`, route `app/src/app/api/mock-agentcard/api/v2/[...path]`)

With `CARD_ISSUER=mock` (the default) the same client points at `${APP_URL}/api/mock-agentcard`. The mock copies the real API: same paths, payloads, error shapes and signed webhooks (delivered after the response with Next's `after()`). PANs pass the Luhn check and start with `400012`. State lives in the JSON store under `mockIssuer`.

Switching to the real sandbox is env only: `CARD_ISSUER=agentcard`, the API URL, client id and secret, webhook secret and `AGENTCARD_USER_ID`.

## Demo shops and card network

- `app/src/lib/shop-catalog.ts`: three stores.
  - `chai-co` accepts the cards.
  - `bandra-gadgets` accepts and waives $6.99 shipping at payment when the subtotal is $40 or more. This is how the demo shows "pay only what was charged".
  - `fortress-electronics` declines with `prepaid_card_not_accepted`. This drives merchant memory.
- `app/src/server/card-network.ts`: `chargeCard` finds the card by last 4, checks number, expiry and CVC, then calls the issuer's `test_charge` or `test_authorization` (declined). So the shops go through the issuer the same way a real network would, and webhooks fire as normal.
- Checkout pages use real field names, `autocomplete` and labels, so a browser agent can fill them like any store.

## Merchant memory (`app/src/server/merchants.ts`)

Each card result records accepted or declined per domain. A store is `declines_virtual_cards` when it declined at least once, never accepted, and the reason is a card-type reason (prepaid, virtual, card type not supported, and similar). Then `anycheckout_pay` rejects before locking any money.

## Decisions

- **Issuing, not Vault or the Commerce SDK.** Vault stores the user's own card behind a passkey, and the Commerce SDK buys at a fixed set of merchants with that Vault card. AnyCheckout needs a fresh card funded by crypto, which only Issuing does (company-funded cards, funds held as USDC).
- **Mock that copies the real API instead of a fake interface.** Agentcard sign-ups are invite-only, so V1 could not use the sandbox. Copying the wire format means the real switch is config, not code.
- **One card per checkout, for exactly the total.** The store cannot charge more than was locked, and a leaked card is useless after one use.
- **Close the card on decline.** Otherwise the agent could retry the same card after the refund.
- **Demo shops instead of real stores.** Sandbox cards do not work on real sites.

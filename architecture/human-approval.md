# Human approval: World ID Agent Pass

Code: `app/src/server/world.ts` (client), `app/src/server/intents.ts` (`startApproval`, `pollApproval`, `decideApproval`), page `app/src/app/approve/[id]/page.tsx`. Mock IdP: `app/src/server/mock-world.ts`, route `app/src/app/api/mock-world/[...path]`, simulated World App at `app/src/app/mock-world/device/page.tsx`.

## When it runs

Only when a purchase is above the per-purchase limit or the weekly amount left. Inside the limits the agent pays alone.

## Flow

1. `anycheckout_pay` returns `needs_approval` and an `approval_url` (our page, not World's).
2. The human opens it. `startApproval` begins an OIDC **Device Authorization Grant** (RFC 8628) with World: `scope=openid`, plus an essential `acr` claim listing the accepted assurance levels. The page shows a QR code and link to World App.
3. The backend polls the token endpoint, following the stop rules: `authorization_pending` (keep going), `slow_down` (wait 5 more seconds), `access_denied`, `expired_token`, and `503` (never treated as approval).
4. `validateIdToken` checks the RS256 signature against World's JWKS, `iss`, `aud`, `exp`, that `auth_time` is fresh for this attempt, and that `acr` is accepted.
5. Binding: the first approval links World's `(iss, sub)` to the user. Later approvals must match it, or they are denied as the wrong person.
6. The human approves or denies the purchase on our page. Approve must happen within 10 minutes of the World check. `approvalRef = keccak256("iss|sub|authTime|intentId")` is passed to `openHold`, so the approval is tied to this one purchase and recorded on-chain.

Denied, cancelled, expired, wrong-person and unverified paths all end with nothing locked and no card issued.

## Modes

`WORLD_MODE`:

- `mock` (default): the same client points at `${APP_URL}/api/mock-world`, which serves discovery, JWKS, device authorization and token endpoints and signs real RS256 tokens. The device page lets you approve as the owner, a stranger, or an unverified account (`acr = none`).
- `sandbox`: `https://sandbox.auth.world.org`.
- `production`: `https://auth.world.org`.

Real modes need `WORLD_CLIENT_ID` and `WORLD_CLIENT_SECRET` from the World developer portal. Client auth defaults to `client_secret_basic`.

## Decisions

- **Device flow.** It is World's documented flow for headless agents. The device code stays on the server, the agent only sees our approval link, so the agent cannot approve its own purchase.
- **Check everything in the token ourselves**, even though World also enforces `acr`.
- **Bind to `(iss, sub)`**, not just "some verified human". Otherwise any World user could approve.
- **Device tokens have no nonce**, and World does not support `binding_message`, so freshness comes from `auth_time` plus the 10-minute window.
- **Single-flight polling.** Two pollers once redeemed the same device code, the second got `invalid_grant`, and the approval was wrongly denied.
- **Gap:** the vault trusts the operator's `approvalRef`. Verifying the approval on-chain (for example in CRE) is the next step.

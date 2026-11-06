# World ID Agent Pass integration debrief

**Use case:** an AI shopping agent can spend from a user's USDC vault within a weekly allowance. Anything above the user's limits is a meaningful action that needs a human: the agent pauses, the human verifies with World ID (device flow, essential `acr` of Orb or Selfie), our backend validates the result, and only then is money locked and a card issued.

**Journey implemented**
1. Request: `anycheckout_pay` returns `needs_approval` and an approval URL. The page starts a Device Authorization Grant with `claims={"id_token":{"acr":{"essential":true,"values":[orb, selfie, orb-face, selfie-face]}}}`.
2. Completion: the human approves in World App (QR or link). `device_code` never leaves the server.
3. Validated result: token polling follows the documented stop rules; the ID token is checked for signature (JWKS), `iss`, `aud`, `exp`, `auth_time` (must belong to this attempt), and an accepted `acr`. `(iss, sub)` is bound: the first approval links it to the vault, later ones must match.
4. Protected action: after a final "Approve $X" tap (the device flow cannot show action terms), the backend opens the on-chain hold with `approvalRef = keccak256(iss|sub|auth_time|intentId)`. The approval is one-use and must be under 10 minutes old when used.
5. Unsuccessful paths, all tested: the human cancels in World App, the request expires, a different World ID approves, an unverified account (no accepted `acr`), or the human taps Deny. In every case nothing is locked and no card exists.

Code: [app/src/server/world.ts](../app/src/server/world.ts), [app/src/server/intents.ts](../app/src/server/intents.ts) (`startApproval`, `pollApprovalInner`, `decideApproval`), page [app/src/app/approve/[id]/page.tsx](../app/src/app/approve/[id]/page.tsx).

## Feedback (from building it)
- **Time to first success:** fill in after the first sandbox run. Locally, the same code path ran against our mock IdP (real RS256 tokens) in about an hour.
- **Friction:** the guides at auth.world.org/docs are client-rendered, so plain `curl` and many coding agents only see an empty page. We read them through the developer MCP endpoint (`get_idp_guide`) instead. A static `.md` per guide (like `coding-agent-setup.md` already has) would fix this.
- **Friction:** callbacks must be exact HTTPS URLs with no `http://localhost`, and device-only clients still need one. Fine for production, but a sandbox exception for localhost would make local agent demos much faster.
- **Missing capability:** `binding_message` is not supported in the device flow, so World App cannot show "Approve $185.99 at Bandra Gadgets". We had to add our own confirmation step after verification. Showing a short action string in World App would make agent checkpoints safer and simpler.
- **One improvement with the greatest impact:** a signed action-approval receipt (the action text inside the ID token or a separate signed object), so the protected action can be verified on-chain or in a Chainlink workflow instead of trusting our backend.

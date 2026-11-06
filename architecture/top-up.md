# Top-up: any token in, USDC in the vault on Arc

Code: `app/src/app/topup/page.tsx` (wallet flow), `app/src/server/uniswap.ts` and `app/src/app/api/uniswap/[action]` (swap proxy), `app/src/server/cctp.ts` and `app/src/app/api/cctp/*` (bridge relay), `claimBridgedDeposit` in the vault.

**Status:** written against the docs, not run yet. Needs a Uniswap API key and testnet funds.

## Flow

1. **Quote.** The user picks a source chain (Base Sepolia, Unichain Sepolia or Sepolia), a token and the USDC amount they want. `/quote` with `EXACT_OUTPUT` so the result is exactly that much USDC.
2. **Approve.** `/check_approval`. If needed the wallet sends the approval tx.
3. **Swap.** Sign the Permit2 typed data from the quote, then `/swap` returns the tx to send.
4. **Bridge.** Approve USDC to CCTP's TokenMessengerV2, then `depositForBurn` to Arc (domain 26) with the **vault** as both `mintRecipient` and `destinationCaller`. `maxFee` comes from Circle's fast transfer fee.
5. **Claim.** The backend polls Circle's Iris API for the attestation (up to 25 minutes), then the operator calls `vault.claimBridgedDeposit(message, attestation)`. The vault credits the original sender.
6. **Policy.** The page also sends `setPolicy` and direct `deposit` on Arc.

## Decisions

- **The Uniswap key stays on the server.** The browser calls our proxy, which adds `x-api-key`.
- **Testnets use protocols `V4`, `V3`, `V2`** (UniswapX is not on testnets).
- **The vault is the destination caller**, so nobody else can redeem the message, and the mint lands in the vault in the same tx that credits the user.
- **Fees in integer math.** Circle can return fractional basis points, so `maxFee` is computed in hundredths of a bps with BigInt.
- **wagmi `injected` connector, imported from `wagmi`.** Importing from `wagmi/connectors` pulled in Coinbase and x402 packages that broke the production build.

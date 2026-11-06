# Settlement: the rules and the Chainlink CRE workflow

Code: `app/src/server/settlement-logic.ts` and its copy `cre/settlement/logic.ts` (tests in `cre/settlement/logic.test.ts`), the workflow `cre/settlement/main.ts`, consumer `onReport` in the vault.

## The rules (`decideSettlement`)

Input: the card's transactions, the hold amount and expiry, the time now, and whether the card is closed.

| Situation | Decision |
|---|---|
| Cleared total above zero | **settle**, charged = cleared total capped at the hold |
| Any transaction authorized or pending | **wait** |
| Card still open and no final result | **wait** |
| Declined or voided | **refund** with reason `DECLINED:<reason>` |
| Card closed or hold expired with nothing charged | **refund** with `CARD_CLOSED_UNUSED` or `TIMEOUT` |

The two files must stay identical. If you change one, change both and run `bun test` in `cre/settlement`.

## CRE workflow (`cre/settlement/main.ts`)

1. **HTTP trigger** with `{holdId, cardId, intentId}`.
2. **EVM read** of `getHold(holdId)` at the last finalized block. Stops unless the hold is open and `cardRef == keccak256(cardId)`.
3. **Agentcard read** on every node (`HTTPClient.sendRequest` with identical consensus): token, card, transactions, sorted so every node gets the same bytes. Credentials come from CRE secrets (`cre/secrets.yaml`).
4. **Decide** with the shared rules.
5. **Report**: `runtime.report` over `abi.encode(vault, action, holdId, charged, ref)`, then `evm.writeReport` to the vault on `arc-testnet` through the forwarder.

Configs: `config.staging.json` points the issuer at the local mock (`http://localhost:3100/api/mock-agentcard`), `config.production.json` at `https://api.agentcard.sh`. HTTP results are cached for 60 seconds so retries do not hit the issuer again.

Run it: `cre workflow simulate --listen --broadcast` from `cre/`, then set `SETTLEMENT_MODE=cre` and `CRE_TRIGGER_URL=http://localhost:2000/trigger` in the app. Simulation reports go through Chainlink's MockKeystoneForwarder on Arc Testnet, so the vault must be deployed with that forwarder.

## Local mode

With `SETTLEMENT_MODE=local` (the default on anvil) the backend runs the same rules and sends the same report bytes through `LocalForwarder`. The vault sees exactly what it would see from CRE.

## Decisions

- **The decision is a pure function shared by both paths**, so local tests prove what CRE will do.
- **Wait while the card is open.** An early refund on an open card once let a later charge succeed after the money was returned. Now the backend closes the card first, and only then can a refund happen.
- **CRE checks the hold on-chain before reading the issuer.** It never settles a hold that is not open, or with a different card.
- **Fallback.** If the CRE trigger cannot be reached, the backend can settle locally (`SETTLEMENT_FALLBACK_LOCAL`). Turn this off in a real deploy, where only the forwarder should settle.

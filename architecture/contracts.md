# Contracts: AnyCheckoutVault

Code: `contracts/src/AnyCheckoutVault.sol`. Tests: `contracts/test/AnyCheckoutVault.t.sol` (23 tests). Deploy: `contracts/script/Deploy.s.sol`.

The vault is a conditional USDC escrow. It holds each user's balance, enforces how much the agent may spend without a human, and locks money per purchase until a settlement report says what was charged.

## Roles

| Role | Who | Can do |
|---|---|---|
| `owner` | Deployer | Change operator, forwarder, treasury, transmitter, grace, workflow checks; sweep surplus |
| `operator` | AnyCheckout backend wallet | `openHold`, `cancelHold`, `claimBridgedDeposit` |
| `forwarder` | Chainlink KeystoneForwarder (MockKeystoneForwarder in simulation, `LocalForwarder` on anvil) | `onReport` (settle or refund) |
| `treasury` | Card float wallet | Receives exactly what each card was charged |
| anyone | | `expireHold` after `expiresAt + settlementGrace` |
| user | | `deposit`, `withdraw`, `setPolicy` |

Constructor: `(usdc, operator, forwarder, treasury, messageTransmitter, settlementGrace)`.

## State

`Account` per user:

- `available`: free balance, the user can withdraw it or the agent can spend it.
- `locked`: sum of open holds.
- `weeklyLimit`, `perPurchaseLimit`: what the agent may spend without a human.
- `spentInWindow`, `windowStart`: autonomous spend in the current 7-day window.
- `agentEnabled`: the kill switch.

`Hold` per purchase (id = `holdIdFor(intentId)`):

- `user`, `status` (None, Open, Settled, Refunded), `humanApproved`, `openedAt`, `expiresAt`
- `amount` (locked), `charged` (paid on settle)
- `merchantRef` = keccak256(merchant domain)
- `approvalRef` = hash of the World ID approval, zero when inside policy
- `cardRef` = keccak256(card id), binds the hold to exactly one card
- `chargeRef` = keccak256(card transaction id) on settle, or the reason on refund

`totalAccounted` tracks every available plus locked balance, so `sweepSurplus` can only take funds sent by mistake.

## Main flows

1. **Deposit.** `deposit` or `depositFor` pulls USDC with `transferFrom`. `claimBridgedDeposit(message, attestation)` takes a CCTP V2 message whose `mintRecipient` and `destinationCaller` are both the vault, calls `receiveMessage`, and credits the minted amount (measured as a balance change) to the `messageSender` or to a beneficiary in `hookData`.
2. **Policy.** `setPolicy(weeklyLimit, perPurchaseLimit, agentEnabled)` is the one signature the user gives. After that, purchases inside the limits need no wallet pop-up.
3. **Open a hold.** `openHold(HoldRequest)` (operator only). With `approvalRef == 0` it checks `perPurchaseLimit` and the weekly amount left, and adds to `spentInWindow`. With a non-zero `approvalRef` (a human approved), it skips the limits and does not count toward them. Moves `amount` from `available` to `locked`.
4. **Settle or refund.** `onReport(metadata, report)` (forwarder only). Report = `abi.encode(address vault, uint8 action, bytes32 holdId, uint256 charged, bytes32 ref)` where action 1 is settle and 2 is refund. The report must name this vault. `_settle` pays `charged` to the treasury and returns `amount - charged`. `_refund` returns everything. Optional `expectedWorkflowId` and `expectedWorkflowOwner` checks read the CRE metadata.
5. **Escape hatches.** `cancelHold` (operator) refunds before any charge. `expireHold` (anyone) refunds after `expiresAt + settlementGrace`.

When a non-human hold refunds inside the same window, `_releaseAllowance` gives that amount back to the weekly allowance.

## Local-only mocks (`contracts/src/dev/`)

- `MockUSDC.sol`: 6 decimals, open mint.
- `LocalForwarder.sol`: `forward(receiver, report)` calls `onReport` with empty metadata, owner only. Stands in for the Chainlink forwarder on anvil.
- `MockMessageTransmitterV2.sol`: parses the real CCTP V2 layout, mints amount minus fee. Has `buildMessage` for tests.

`Deploy.s.sol` deploys these mocks only when the matching env var is unset, and writes `contracts/deployments/<chainId>.json`.

## Decisions

- **Single file, no imports.** So it can be pasted into Arc Studio as is (Arc prizes require a Studio project). Includes its own tiny IERC20 and reentrancy lock.
- **Only the USDC ERC-20 interface, never `msg.value`.** On Arc, native USDC has 18 decimals but the ERC-20 at `0x3600...0000` has 6. Mixing them is a classic bug.
- **The card id is committed on-chain (`cardRef`).** The card is created first, then the hold. CRE checks `cardRef == keccak256(cardId)` before it trusts any card data, so a report can never settle one hold with another card's charge.
- **Charged amount is capped at the hold.** `ChargeExceedsHold` reverts. The card is also issued for exactly the hold amount.
- **Anyone can force a refund after the grace period.** The backend going down must not freeze user money.
- **Human-approved holds do not use the weekly allowance.** The allowance is for what the agent does alone.

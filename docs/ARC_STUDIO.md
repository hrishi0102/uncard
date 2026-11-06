# Arc Studio prompt

Every Arc prize asks for Arc Studio as the starting point and a shareable Studio project URL. Open https://studio.arc.io, choose **Smart Contract** mode, and paste the prompt below together with the full contents of `contracts/src/AnyCheckoutVault.sol` (it is one file with no imports on purpose).

```text
Build and deploy a conditional USDC escrow for AI-agent card purchases on Arc testnet.

Target: Arc testnet. Use the USDC ERC-20 interface at 0x3600000000000000000000000000000000000000 (6 decimals). Never use msg.value.

Use the Solidity contract I paste below (AnyCheckoutVault) as the source. Keep its logic:
- Users deposit USDC and set an agent policy: weeklyLimit, perPurchaseLimit, agentEnabled (one signature).
- An operator opens a hold for an exact checkout amount without a user signature, only inside the policy.
  A non-zero approvalRef (a World ID approval) lets one purchase go above the limits.
- Settlement arrives as a Chainlink CRE report via onReport(metadata, report) from the forwarder:
  report = abi.encode(address vault, uint8 action, bytes32 holdId, uint256 charged, bytes32 ref).
  SETTLE pays exactly `charged` to the treasury and returns the rest to the user. REFUND returns everything.
- Anyone can expireHold after expiresAt + settlementGrace for a full refund.
- claimBridgedDeposit(message, attestation) receives CCTP V2 USDC minted to the vault and credits the burn's sender.

Constructor args for testnet:
- usdc: 0x3600000000000000000000000000000000000000
- operator: <my backend address>
- forwarder: 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1 (CRE MockKeystoneForwarder for simulation)
- treasury: <my treasury address>
- messageTransmitter: 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275 (CCTP V2 on Arc testnet)
- settlementGrace: 1800

Write tests for: a hold inside the policy, a hold above the per-purchase limit that needs approvalRef, a partial settlement
(lock 54.48, charge 47.49, user gets 6.99 back), a refund on decline, expiry after ttl + grace, and only-forwarder onReport.
Run the checks, then deploy to Arc testnet and give me the address. Do not change the report encoding.
```

After Studio deploys it, put the address in `app/.env.local` (`VAULT_ADDRESS`) and in `cre/settlement/config.staging.json`, and show Studio in the demo video.

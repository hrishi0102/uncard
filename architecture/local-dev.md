# Local development

Everything runs on a local chain with the mock card issuer and mock World IdP, so no keys are needed. Needs Node 22+, Foundry, and Bun (only for the CRE workflow).

## Run it

```bash
npm --prefix app install
```

```bash
npm run chain
```

```bash
npm run local:setup
```

```bash
npm run dev
```

```bash
npm run demo:agent
```

- `chain`: anvil on `127.0.0.1:8545`, chain id 31337.
- `local:setup` (`scripts/local-setup.sh`): deploys the vault and mocks, gives the demo user 1000 USDC with 500 deposited and a $200 weekly / $100 per-purchase policy, writes `app/.env.local`, clears `app/.data`. Uses anvil account 0 as operator, 1 as the user, 2 as treasury.
- `dev`: the app on http://localhost:3100. Port 3100 because another project in the parent folder uses 3000.
- `demo:agent` (`scripts/demo-agent.mjs`): a scripted agent runs five cases through MCP: partial charge, decline plus merchant memory, above-limit approved with World ID, the same denied, abandoned checkout.

Other scripts: `npm run test:contracts` (forge), `npm run abi` (exports ABIs into `app/src/server/abi/`), `bun test` in `cre/settlement`.

## Connect a real agent

```bash
claude mcp add --transport http anycheckout http://localhost:3100/api/mcp --header "Authorization: Bearer ak_demo_local_only_change_me"
```

Then ask it to buy something at http://localhost:3100/shop/chai-co and pay with AnyCheckout.

## Modes (env)

See `app/.env.example` for the full list.

| Var | Values | Default |
|---|---|---|
| `CARD_ISSUER` | `mock`, `agentcard` | `mock` |
| `WORLD_MODE` | `mock`, `sandbox`, `production` | `mock` |
| `SETTLEMENT_MODE` | `local`, `cre` | `local` |
| `SETTLEMENT_FALLBACK_LOCAL` | `true`, `false` | `true` |
| `HOLD_TTL_SECONDS` | seconds | `900` |
| `UNISWAP_API_KEY`, `UNISWAP_CHAIN_ID` | | unset, `84532` |

## Going to testnet

- Arc Testnet deploy: `scripts/deploy-arc.sh` (needs `DEPLOYER_PRIVATE_KEY` and faucet USDC for gas, uses `--with-gas-price 25gwei`).
- Agentcard sandbox: `scripts/agentcard-setup.mjs`.
- The full checklist of sign-ups and keys is `docs/MORNING.md`.

## Local addresses (fresh anvil)

Deterministic on a fresh chain: vault `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9`, USDC `0x5FbDB2315678afecb367f032d93F642f64180aa3`, LocalForwarder `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`, demo user `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`.

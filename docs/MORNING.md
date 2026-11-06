# Morning checklist: keys and sign-ups only you can do

Everything below needs an account, a faucet (captcha), or a key, so I did not do it. Each step is independent. Do them in this order for the best prize coverage per minute. Nothing here costs money: all testnet and sandbox.

## 0. See it working (5 min, no keys)

```bash
cd anycheckout && npm --prefix app install
```

```bash
npm run chain
```

```bash
npm run local:setup && npm run dev
```

```bash
npm run demo:agent
```

Open http://localhost:3100/dashboard, http://localhost:3100/shop, and try a purchase above $100 to see the World ID approval page.

Note: another Claude session is building a different project in the parent `ethglobal/` folder and already uses port 3000, so AnyCheckout runs on **3100**. `anycheckout/` is its own git repo (10+ commits, history kept for the "fresh code" rule).

## 1. Push to a public GitHub repo (needed by Uniswap)

```bash
cd anycheckout && gh repo create anycheckout --public --source . --push
```

## 2. Arc Testnet + Arc Studio (needed for every Arc prize)

1. Get testnet USDC (it is also the gas token) for a deployer wallet at https://faucet.circle.com (pick Arc Testnet).
2. Arc requires Arc Studio as the starting point: open https://studio.arc.io, use **Smart Contract** mode, and paste the prompt in [ARC_STUDIO.md](ARC_STUDIO.md). Let Studio test and deploy the vault, and keep the shareable project URL for the submission.
3. Or deploy from the terminal (same contract):

```bash
DEPLOYER_PRIVATE_KEY=0x... bash scripts/deploy-arc.sh
```

4. Copy the printed lines into `app/.env.local` (replace the local chain block). Deposit and set limits from http://localhost:3100/topup with the wallet you put in `DEMO_USER_ADDRESS`.

## 3. Chainlink CRE (Best workflow with CRE)

```bash
curl -sSL https://app.chain.link/cre/install.sh | bash
```

```bash
cre login
```

Then:
1. `cp cre/.env.example cre/.env`, set `CRE_ETH_PRIVATE_KEY` (a wallet with Arc testnet USDC for gas). For the mock issuer keep `AGENTCARD_CLIENT_ID_ALL=mock_client_id` and `AGENTCARD_CLIENT_SECRET_ALL=mock_client_secret`.
2. Put the vault address in `cre/settlement/config.staging.json`.
3. Install and start the simulator in listen mode (it settles every checkout for real on Arc Testnet):

```bash
cd cre/settlement && bun install && cd .. && cre workflow simulate settlement --target staging-settings --listen --broadcast --limits none
```

4. In `app/.env.local` set `SETTLEMENT_MODE=cre` and restart `npm run dev`. Each card result now triggers the workflow at `http://localhost:2000/trigger`.

The vault was deployed with the CRE **MockKeystoneForwarder** (`0x6E9E…eDc1`), which is what simulation uses. For a deployed workflow later: `setForwarder(0x76c9cf548b4179F8901cda1f8623568b58215E62)`.

## 4. World ID Agent Pass (World prize, $5k pool)

1. Sign in with Google at https://sandbox.auth.world.org/portal and register an app. A device-only client still needs one exact **HTTPS** redirect URI (any URL you own, it is not called by the device flow). Keep the client id and secret.
2. In `app/.env.local`:

```bash
WORLD_MODE=sandbox
WORLD_CLIENT_ID=...
WORLD_CLIENT_SECRET=...
```

3. The prize page says sandbox proofs are mocked now, so the sandbox World App may not be needed. If it is, the TestFlight link is on the prize page.
4. Fill your own numbers into [WORLD_DEBRIEF.md](WORLD_DEBRIEF.md) (time to first success etc.). It is a qualification requirement.

## 5. Agentcard sandbox (optional: the mock already matches their API)

Sign-ups are invite-only right now (`agent-cards signup` books a call). If you have access:

```bash
npx agent-cards signin
```

```bash
npx agent-cards credentials --mode sandbox
```

Switch the org to company-funded (Dashboard, Settings, Issuing, owner only), then:

```bash
AGENTCARD_CLIENT_ID=... AGENTCARD_CLIENT_SECRET=... DEMO_EMAIL=you@example.com node scripts/agentcard-setup.mjs
```

Set `CARD_ISSUER=agentcard` plus the printed values. Without a public webhook URL the app polls `/transactions`, so a tunnel is optional. If you never get access, say so in the demo: "the card issuer is a mock of Agentcard's exact API because sign-ups are invite-only".

## 6. Uniswap (Build with Uniswap, $10k pool)

1. Create an API key at https://developers.uniswap.org/dashboard and set `UNISWAP_API_KEY` in `app/.env.local`.
2. Get Base Sepolia ETH and USDC (faucet.circle.com), then run http://localhost:3100/topup: swap WETH to USDC, bridge into the vault.
3. Add your own notes to [../FEEDBACK.md](../FEEDBACK.md) and submit the form at https://developers.uniswap.org/hackathon-feedback with the link to `FEEDBACK.md` on GitHub. Required to qualify.

## 7. Submission

- Video: follow [DEMO_SCRIPT.md](DEMO_SCRIPT.md).
- Architecture diagram: the mermaid diagram in the README (Arc asks for one).
- Say which bounties: Arc "Best Smart Contracts with Advanced Stablecoin Logic", Chainlink "Best workflow with CRE", World "World ID Agent Pass", Uniswap "Build with Uniswap".

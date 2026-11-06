# Uniswap developer feedback (AnyCheckout, ETHGlobal Mumbai)

What we built with Uniswap: "pay with any token". A user tops up their AnyCheckout vault by swapping any ERC-20 into an exact amount of USDC with the Uniswap Trading API (`/check_approval`, `/quote` with `EXACT_OUTPUT`, `/swap`) on Base Sepolia, then moves the USDC to Arc with Circle CCTP. Code: [app/src/server/uniswap.ts](app/src/server/uniswap.ts) and [app/src/app/topup/page.tsx](app/src/app/topup/page.tsx).

## What worked well
- `llms.txt` plus per-page Markdown (`/docs/<path>.md`) made the docs easy for a coding agent to read without a browser.
- `EXACT_OUTPUT` is exactly what a payments product needs: "give me 25.00 USDC, tell me what it costs".
- The integration guide's "WRONG / CORRECT" examples for `signature` + `permitData` on `/swap` prevented a real bug.
- The `X-Agent-Info` attribution header is a nice touch for agent-built integrations.

## Friction
- Testnet support is only clear on the supported-chains page. Arc mainnet is supported but Arc Testnet is not, which matters for teams building on Arc during this event.
- On testnets UniswapX is unavailable, so we had to pin `protocols: ["V4","V3","V2"]`. A short note in the quote docs ("on testnets, pass protocols") would save a failed first call.
- Testnet liquidity for USDC pairs is hard to predict before you have a key. A public "is there a route for X to Y on chain Z" check without a key would help hackathon teams plan.

## Missing capability we would use
- Cross-chain `EXACT_OUTPUT` straight into a contract on another chain (swap on Base Sepolia, receive USDC on Arc Testnet into a vault with hook data). We built it ourselves with CCTP.

## To fill in (team)
- Time to first successful quote:
- Any errors hit and how long they took to solve:
- The one improvement with the greatest impact:

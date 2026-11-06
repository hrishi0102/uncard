# Demo video script (about 3 minutes)

**Setup before recording:** dashboard open in one tab, Claude (or `npm run demo:agent`) in a terminal, Arc explorer ready. Fresh state: `npm run local:setup` (or testnet vault with a fresh demo user).

1. **The problem (15s).** "Shopping agents can browse any site, but checkout wants a card. I hold crypto. AnyCheckout is one MCP tool that bridges the two, and you only pay what was charged."

2. **Connect the agent (15s).** Dashboard, "Copy Claude Code command", paste. Show the 5 tools.

3. **Normal purchase, partial charge (45s).** Ask the agent to buy a power bank and a cable at Bandra Gadgets. Show: the agent calls `anycheckout_pay` for $54.48, gets a card, types it in. The store waives shipping at payment and charges $47.49. On the dashboard, the receipt prints: Locked $54.48, Charged $47.49, Returned $6.99, with the Arc transaction. Say: "No wallet pop-up: it was inside my weekly allowance."

4. **The human check (45s).** Ask for the $185.99 headphones. The agent says it needs approval and shares the link. Open it on the phone: purchase details, "Verify with World ID", approve in World App, tap "Approve $185.99". Back in the agent: card issued, paid, settled. Also show one deny to prove nothing gets locked.

5. **Decline + memory (30s).** Ask for a mouse at Fortress Electronics. The store refuses virtual cards, the receipt shows "Refunded", and Merchant memory now lists Fortress. Ask again: the tool refuses before locking any money.

6. **Under the hood (30s).** Show the CRE simulator terminal settling a hold (EVM read, Agentcard read, report written), Arc Studio with the vault contract, and the top-up page (Uniswap quote then CCTP into the vault).

7. **Close (10s).** "Any agent, any card checkout, any token, and you only pay what was charged."

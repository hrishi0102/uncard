#!/usr/bin/env bash
# Deploys AnyCheckout to a local anvil chain, seeds the demo user, and writes app/.env.local.
# Start the chain first in another terminal:  npm run chain
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${RPC_URL:-http://127.0.0.1:8545}"

# Well-known anvil test keys (public, local only).
OPERATOR_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # account 0: owner + operator
USER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d       # account 1: demo user
USER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
TREASURY=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC                               # account 2: card float treasury

if ! cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "No chain at $RPC. Start it first:  npm run chain"; exit 1
fi

cd "$ROOT/contracts"
forge build --silent
TREASURY_ADDRESS=$TREASURY SETTLEMENT_GRACE=300 \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$OPERATOR_PK" --silent >/dev/null
DEP="$ROOT/contracts/deployments/31337.json"
j() { node -e "console.log(require('$DEP').$1)"; }
VAULT=$(j vault); USDC=$(j usdc); FWD=$(j forwarder); MT=$(j messageTransmitter)
echo "Vault $VAULT  USDC $USDC  LocalForwarder $FWD"

# Seed the demo user: 1,000 mock USDC, deposit 500, agent policy $200/week and $100/purchase.
cast send "$USDC" "mint(address,uint256)" $USER 1000000000 --rpc-url "$RPC" --private-key "$USER_PK" >/dev/null
cast send "$USDC" "approve(address,uint256)" "$VAULT" 500000000 --rpc-url "$RPC" --private-key "$USER_PK" >/dev/null
cast send "$VAULT" "deposit(uint256)" 500000000 --rpc-url "$RPC" --private-key "$USER_PK" >/dev/null
cast send "$VAULT" "setPolicy(uint128,uint128,bool)" 200000000 100000000 true --rpc-url "$RPC" --private-key "$USER_PK" >/dev/null
echo "Demo user $USER: deposited 500 USDC, weekly allowance 200, per purchase 100"

ENV="$ROOT/app/.env.local"
cat > "$ENV" <<ENVEOF
# Written by scripts/local-setup.sh (local anvil). See app/.env.example for testnet settings.
APP_URL=http://localhost:3100
CHAIN_NAME=Local Anvil
CHAIN_ID=31337
RPC_URL=$RPC
VAULT_ADDRESS=$VAULT
USDC_ADDRESS=$USDC
LOCAL_FORWARDER_ADDRESS=$FWD
MESSAGE_TRANSMITTER_ADDRESS=$MT
OPERATOR_PRIVATE_KEY=$OPERATOR_PK
DEMO_USER_PRIVATE_KEY=$USER_PK
DEMO_USER_ADDRESS=$USER
AGENT_KEY=ak_demo_local_only_change_me
HOLD_TTL_SECONDS=900

CARD_ISSUER=mock
SETTLEMENT_MODE=local
WORLD_MODE=mock
ENVEOF
rm -rf "$ROOT/app/.data"
echo "Wrote $ENV (and cleared app/.data). Now run:  npm run dev"

#!/usr/bin/env bash
# Deploys AnyCheckoutVault to Arc Testnet and prints the app/.env.local lines.
#
#   DEPLOYER_PRIVATE_KEY=0x...   (funded with testnet USDC from https://faucet.circle.com, USDC is gas on Arc)
#   OPERATOR_ADDRESS=0x...       (backend key that opens holds; defaults to the deployer)
#   TREASURY_ADDRESS=0x...       (receives what cards were charged; defaults to the deployer)
#   bash scripts/deploy-arc.sh
#
# The forwarder is the CRE MockKeystoneForwarder, which `cre workflow simulate --broadcast` uses.
# After deploying the workflow for real, switch it:  cast send $VAULT "setForwarder(address)" 0x76c9cf548b4179F8901cda1f8623568b58215E62
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.io}"
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY}"
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")

export USDC_ADDRESS=0x3600000000000000000000000000000000000000            # Arc USDC (ERC-20 interface, 6 decimals)
export FORWARDER_ADDRESS="${FORWARDER_ADDRESS:-0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1}"  # CRE MockKeystoneForwarder
export MESSAGE_TRANSMITTER=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275    # CCTP V2 MessageTransmitterV2 (Arc Testnet)
export OPERATOR_ADDRESS="${OPERATOR_ADDRESS:-$DEPLOYER}"
export TREASURY_ADDRESS="${TREASURY_ADDRESS:-$DEPLOYER}"
export SETTLEMENT_GRACE="${SETTLEMENT_GRACE:-1800}"

cd "$ROOT/contracts"
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY" \
  --with-gas-price 25gwei --priority-gas-price 1gwei --slow
DEP="$ROOT/contracts/deployments/5042002.json"
VAULT=$(node -e "console.log(require('$DEP').vault)")

cat <<EOF

Deployed AnyCheckoutVault on Arc Testnet: $VAULT
Explorer: https://explorer.testnet.arc.io/address/$VAULT

app/.env.local:
CHAIN_NAME=Arc Testnet
CHAIN_ID=5042002
RPC_URL=$RPC
EXPLORER_URL=https://explorer.testnet.arc.io
VAULT_ADDRESS=$VAULT
USDC_ADDRESS=$USDC_ADDRESS
MESSAGE_TRANSMITTER_ADDRESS=$MESSAGE_TRANSMITTER
OPERATOR_PRIVATE_KEY=<private key of $OPERATOR_ADDRESS>
DEMO_USER_ADDRESS=<the wallet you will deposit from>
SETTLEMENT_MODE=cre

cre/settlement/config.staging.json:  "vaultAddress": "$VAULT"
EOF

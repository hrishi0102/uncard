import "server-only";

/**
 * All runtime configuration in one place. Everything has a local-demo default so
 * `npm run dev` works with zero keys (mock card issuer, mock World IdP, local settlement).
 * Real integrations switch on when their env vars are present. See app/.env.example.
 */

const env = (key: string, fallback = ""): string => process.env[key]?.trim() || fallback;
const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const appUrl = env("APP_URL", "http://localhost:3100").replace(/\/$/, "");

export type CardIssuerMode = "mock" | "agentcard";
export type SettlementMode = "local" | "cre";
export type WorldMode = "mock" | "sandbox" | "production";

const cardIssuer = (env("CARD_ISSUER", "mock") as CardIssuerMode) === "agentcard" ? "agentcard" : "mock";
const worldModeRaw = env("WORLD_MODE", "mock");
const worldMode: WorldMode =
  worldModeRaw === "sandbox" || worldModeRaw === "production" ? worldModeRaw : "mock";

export const config = {
  appUrl,
  dataDir: env("DATA_DIR", ".data"),

  chain: {
    name: env("CHAIN_NAME", "Local Anvil"),
    id: num("CHAIN_ID", 31337),
    rpcUrl: env("RPC_URL", "http://127.0.0.1:8545"),
    explorerUrl: env("EXPLORER_URL", ""),
    isLocal: num("CHAIN_ID", 31337) === 31337,
    vault: env("VAULT_ADDRESS") as `0x${string}`,
    usdc: env("USDC_ADDRESS") as `0x${string}`,
    localForwarder: env("LOCAL_FORWARDER_ADDRESS") as `0x${string}`,
    messageTransmitter: env("MESSAGE_TRANSMITTER_ADDRESS") as `0x${string}`,
    operatorKey: env("OPERATOR_PRIVATE_KEY") as `0x${string}`,
    // Only used in local demo mode, so the dashboard can act for the demo user without a wallet.
    demoUserKey: env("DEMO_USER_PRIVATE_KEY") as `0x${string}`,
  },

  demo: {
    userAddress: env("DEMO_USER_ADDRESS") as `0x${string}`,
    userName: env("DEMO_USER_NAME", "Hrishi (demo)"),
    userEmail: env("DEMO_USER_EMAIL", "demo@anycheckout.dev"),
    agentKey: env("AGENT_KEY", "ak_demo_local_only_change_me"),
  },

  hold: {
    ttlSeconds: num("HOLD_TTL_SECONDS", 15 * 60),
  },

  cardIssuer: {
    mode: cardIssuer as CardIssuerMode,
    apiUrl:
      cardIssuer === "agentcard"
        ? env("AGENTCARD_API_URL", "https://api.agentcard.sh")
        : `${appUrl}/api/mock-agentcard`,
    clientId: cardIssuer === "agentcard" ? env("AGENTCARD_CLIENT_ID") : "mock_client_id",
    clientSecret: cardIssuer === "agentcard" ? env("AGENTCARD_CLIENT_SECRET") : "mock_client_secret",
    webhookSecret: cardIssuer === "agentcard" ? env("AGENTCARD_WEBHOOK_SECRET") : "whsec_mock_local",
    // The connected + KYC-approved Agentcard user that cards are issued to (see scripts/agentcard-setup.ts).
    userId: env("AGENTCARD_USER_ID"),
  },

  settlement: {
    mode: (env("SETTLEMENT_MODE", "local") === "cre" ? "cre" : "local") as SettlementMode,
    // `cre workflow simulate settlement --listen` serves this. A deployed workflow uses its HTTP trigger URL.
    creTriggerUrl: env("CRE_TRIGGER_URL", "http://localhost:2000/trigger"),
    // If the CRE simulator is not running, fall back to the local forwarder (local chain only).
    fallbackToLocal: env("SETTLEMENT_FALLBACK_LOCAL", "true") === "true",
  },

  world: {
    mode: worldMode,
    issuer:
      worldMode === "mock"
        ? `${appUrl}/api/mock-world`
        : worldMode === "sandbox"
          ? env("WORLD_ISSUER", "https://sandbox.auth.world.org")
          : env("WORLD_ISSUER", "https://auth.world.org"),
    clientId: worldMode === "mock" ? "mock_world_client" : env("WORLD_CLIENT_ID"),
    clientSecret: worldMode === "mock" ? "mock_world_secret" : env("WORLD_CLIENT_SECRET"),
    // Accepted authentication classes (any one is enough).
    acceptedAcr: env(
      "WORLD_ACCEPTED_ACR",
      "https://world.org/oidc/acr/orb,https://world.org/oidc/acr/selfie,https://world.org/oidc/acr/orb-face,https://world.org/oidc/acr/selfie-face",
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // How long after we start an approval the World authentication may have happened.
    clockToleranceSeconds: 120,
  },

  uniswap: {
    apiKey: env("UNISWAP_API_KEY"),
    apiUrl: env("UNISWAP_API_URL", "https://trade-api.gateway.uniswap.org/v1"),
    chainId: num("UNISWAP_CHAIN_ID", 84532), // Base Sepolia
    usdc: env("UNISWAP_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`,
  },

  cctp: {
    irisUrl: env("CCTP_IRIS_URL", "https://iris-api-sandbox.circle.com"),
    destinationDomain: num("CCTP_DESTINATION_DOMAIN", 26), // Arc
  },
};

export function modes() {
  return {
    chain: config.chain.name,
    chainId: config.chain.id,
    cardIssuer: config.cardIssuer.mode,
    settlement: config.settlement.mode,
    world: config.world.mode,
    uniswap: config.uniswap.apiKey ? "live" : "no-key",
  };
}

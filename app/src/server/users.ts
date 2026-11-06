import "server-only";
import { privateKeyToAccount } from "viem/accounts";
import { agentcard } from "./agentcard";
import { config } from "./config";
import { ensureMockWebhook } from "./mock-agentcard";
import { read, write } from "./store";
import type { Hex, User } from "./types";

export const DEMO_USER_ID = "user_demo";

function demoWallet(): Hex {
  if (config.demo.userAddress) return config.demo.userAddress;
  if (config.chain.demoUserKey) return privateKeyToAccount(config.chain.demoUserKey).address;
  throw new Error("Set DEMO_USER_ADDRESS (or DEMO_USER_PRIVATE_KEY on the local chain)");
}

/** The single demo user of this V1 (multi-user sign-in is out of scope for the hackathon). */
export async function ensureDemoUser(): Promise<User> {
  const existing = read().users[DEMO_USER_ID];
  if (existing && existing.agentcardUserId && existing.wallet === demoWallet()) return existing;

  const user: User = existing ?? {
    id: DEMO_USER_ID,
    name: config.demo.userName,
    email: config.demo.userEmail,
    wallet: demoWallet(),
    agentKeys: [{ key: config.demo.agentKey, label: "Demo agent", createdAt: new Date().toISOString() }],
  };
  user.wallet = demoWallet();
  if (!user.agentKeys.some((k) => k.key === config.demo.agentKey)) {
    user.agentKeys.push({ key: config.demo.agentKey, label: "Demo agent", createdAt: new Date().toISOString() });
  }

  if (config.cardIssuer.mode === "agentcard") {
    if (!config.cardIssuer.userId) {
      throw new Error("Set AGENTCARD_USER_ID (run `npm run agentcard:setup` once to create the sandbox user)");
    }
    user.agentcardUserId = config.cardIssuer.userId;
  } else if (!user.agentcardUserId) {
    user.agentcardUserId = await provisionIssuerUser(user.email);
  }

  await write((db) => {
    db.users[DEMO_USER_ID] = user;
  });
  return user;
}

/** Agentcard sandbox onboarding: connect (code 111111), consent, simulated KYC, fund the company wallet. */
export async function provisionIssuerUser(email: string): Promise<string> {
  if (config.cardIssuer.mode === "mock") await ensureMockWebhook();
  const attempt = await agentcard.connectStart(email);
  const conn = await agentcard.connectVerify(attempt.id, "111111");
  await agentcard.consent(conn.user.id);
  await agentcard.kycSimulate(conn.user.id, "approved");
  const wallet = await agentcard.companyWallet();
  if (wallet.available_cents < 50_000) await agentcard.testFundCompanyWallet(100_000);
  return conn.user.id;
}

export function userByAgentKey(key: string | null | undefined): User | undefined {
  if (!key) return undefined;
  return Object.values(read().users).find((u) => u.agentKeys.some((k) => k.key === key));
}

export function agentLabel(user: User, key: string) {
  return user.agentKeys.find((k) => k.key === key)?.label ?? "agent";
}

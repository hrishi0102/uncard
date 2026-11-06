export type Hex = `0x${string}`;

export type User = {
  id: string;
  name: string;
  email: string;
  wallet: Hex;
  agentKeys: { key: string; label: string; createdAt: string }[];
  /** World ID linked at the first approval, matched on every later one: (iss, sub). */
  world?: { iss: string; sub: string; linkedAt: string; acr?: string };
  /** Agentcard user that cards are issued to (connected + KYC approved). */
  agentcardUserId?: string;
};

export type IntentStatus =
  | "needs_approval" // waiting for the human (World ID step-up)
  | "denied" // human said no, cancelled, expired, or wrong World ID. Nothing moved.
  | "rejected" // policy said no (balance, kill switch, known-bad merchant). Nothing moved.
  | "processing" // issuing the card and locking funds
  | "card_issued" // funds locked on Arc, single-use card handed to the agent
  | "charged" // merchant charge cleared, settlement report in flight
  | "declined" // merchant declined the card, refund report in flight
  | "settled" // CRE report landed: charged amount paid, rest returned
  | "refunded" // full refund landed (decline, timeout, cancel)
  | "failed"; // something broke; any lock was released

export type TimelineEvent = { at: string; type: string; detail: string; tx?: Hex };

export type Intent = {
  id: string;
  holdId: Hex;
  userId: string;
  agentLabel: string;
  idempotencyKey?: string;
  merchant: { name: string; domain: string; url?: string };
  amountCents: number;
  currency: "USD";
  description: string;
  status: IntentStatus;
  reasons: string[];
  approval?: {
    required: boolean;
    reason: string;
    status: "pending" | "verifying" | "verified" | "approved" | "denied" | "expired" | "error";
    approvalRef?: Hex;
    world?: { iss: string; sub: string; acr?: string; amr?: string[]; authTime: number };
    error?: string;
    decidedAt?: string;
  };
  card?: { id: string; last4: string; expiry: string; closed?: boolean; lastPolledAt?: number };
  hold?: { txHash: Hex; block?: number; openedAt: string; expiresAt: string };
  charge?: {
    transactionId: string;
    amountCents: number;
    status: "cleared" | "declined" | "authorized" | "voided";
    declineReason?: string;
    at: string;
  };
  settlement?: {
    requestedAt?: string;
    via?: "cre" | "local";
    action?: "settle" | "refund";
    txHash?: Hex;
    chargedCents?: number;
    refundedCents?: number;
    at?: string;
    error?: string;
  };
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
};

export type MerchantMemory = {
  domain: string;
  name: string;
  accepted: number;
  declined: number;
  lastDeclineReason?: string;
  lastSeen: string;
};

/** Server-side-only state for a World ID approval attempt (never sent to the agent). */
export type ApprovalAttempt = {
  intentId: string;
  startedAt: number; // unix seconds
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
};

// ---------------- mock Agentcard (same REST shapes as api.agentcard.sh) ----------------

export type MockCard = {
  id: string;
  user_id: string;
  status: "open" | "closed";
  type: "single_use" | "multi_use";
  spend_limit_cents: number;
  balance_cents: number;
  number: string;
  cvc: string;
  exp_month: string;
  exp_year: string;
  last4: string;
  closed_reason?: string;
  created_at: string;
  idempotency_key?: string;
};

export type MockTransaction = {
  id: string;
  card_id: string;
  user_id: string;
  status: "authorized" | "cleared" | "declined" | "voided";
  amount: number;
  merchant: string;
  mcc: string;
  decline_reason: string | null;
  created_at: string;
};

export type Db = {
  version: 1;
  users: Record<string, User>;
  intents: Record<string, Intent>;
  merchants: Record<string, MerchantMemory>;
  webhookEventIds: string[];
  approvals: Record<string, ApprovalAttempt>;
  mockIssuer: {
    cards: Record<string, MockCard>;
    transactions: Record<string, MockTransaction>;
    users: Record<string, { id: string; email: string; kyc: string; consent: boolean }>;
    connects: Record<string, { email: string }>;
    webhooks: { id: string; url: string; secret: string; enabled_events: string[] }[];
    walletCents: number;
  };
  mockWorld: {
    deviceCodes: Record<
      string,
      {
        userCode: string;
        clientId: string;
        status: "pending" | "approved" | "denied";
        sub?: string;
        createdAt: number;
        expiresAt: number;
        authTime?: number;
        acr?: string;
      }
    >;
    privateJwk: Record<string, unknown> | null;
    publicJwk: Record<string, unknown> | null;
  };
  bridgeClaims: Record<
    string,
    { txHash: string; sourceDomain: number; status: string; claimTx?: string; error?: string; at: string }
  >;
};

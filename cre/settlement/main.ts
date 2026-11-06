/**
 * AnyCheckout settlement workflow (Chainlink CRE).
 *
 * Trigger: HTTP. The AnyCheckout backend posts { holdId, cardId } when the card issuer reports a
 * charge, a decline, or a card that expired unused.
 *
 *  1. EVM read (Arc Testnet): vault.getHold(holdId). The hold must be open and its cardRef must equal
 *     keccak256(cardId), so a caller can never point a hold at someone else's card.
 *  2. HTTP (every node, identical consensus): read the card and its transactions straight from the
 *     Agentcard Issuing API. The backend's word is never trusted for the outcome.
 *  3. Decide: SETTLE the cleared amount (rest goes back to the user) or REFUND on decline / unused card.
 *  4. EVM write: a DON-signed report to AnyCheckoutVault.onReport via the Chainlink forwarder.
 */
import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  decodeJson,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  type HTTPPayload,
  type HTTPSendRequester,
  json,
  LAST_FINALIZED_BLOCK_NUMBER,
  ok,
  Runner,
  type Runtime,
  TxStatus,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, toBytes, zeroAddress } from "viem";
import { decideSettlement, type IssuerTxn } from "./logic";

type Config = {
  agentcardBaseUrl: string;
  chainSelectorName: string;
  vaultAddress: `0x${string}`;
  gasLimit: string;
};

type TriggerInput = { holdId: `0x${string}`; cardId: string; intentId?: string };

const ACTION_SETTLE = 1;
const ACTION_REFUND = 2;
const HOLD_OPEN = 1;

const VAULT_ABI = [
  {
    type: "function",
    name: "getHold",
    stateMutability: "view",
    inputs: [{ name: "holdId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "user", type: "address" },
          { name: "status", type: "uint8" },
          { name: "humanApproved", type: "bool" },
          { name: "openedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
          { name: "amount", type: "uint256" },
          { name: "charged", type: "uint256" },
          { name: "merchantRef", type: "bytes32" },
          { name: "approvalRef", type: "bytes32" },
          { name: "cardRef", type: "bytes32" },
          { name: "chargeRef", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

type CardSnapshot = { cardClosed: boolean; txns: IssuerTxn[] };

/** Runs on every node. Returns a canonical snapshot so the DON can agree on identical results. */
const readCardFromIssuer =
  (cardId: string, clientId: string, clientSecret: string) =>
  (sendRequester: HTTPSendRequester, config: Config): string => {
    const base = config.agentcardBaseUrl.replace(/\/$/, "");
    const form = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
    const tokenResp = sendRequester
      .sendRequest({
        url: `${base}/api/v2/oauth/token`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: Buffer.from(form).toString("base64"),
        cacheSettings: { store: true, maxAge: "60s" },
      })
      .result();
    if (!ok(tokenResp)) throw new Error(`Agentcard token request failed: ${tokenResp.statusCode}`);
    const token = (json(tokenResp) as { access_token: string }).access_token;
    const auth = { Authorization: `Bearer ${token}` };

    const cardResp = sendRequester.sendRequest({ url: `${base}/api/v2/cards/${cardId}`, method: "GET", headers: auth }).result();
    if (!ok(cardResp)) throw new Error(`Agentcard card read failed: ${cardResp.statusCode}`);
    const card = json(cardResp) as { status: string };

    const txResp = sendRequester
      .sendRequest({ url: `${base}/api/v2/transactions?card_id=${encodeURIComponent(cardId)}`, method: "GET", headers: auth })
      .result();
    if (!ok(txResp)) throw new Error(`Agentcard transactions read failed: ${txResp.statusCode}`);
    const list = json(txResp) as { data: IssuerTxn[] };

    const snapshot: CardSnapshot = {
      cardClosed: card.status === "closed",
      txns: list.data
        .map((t) => ({ id: t.id, status: t.status, amount: t.amount ?? null, decline_reason: t.decline_reason ?? null }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
    return JSON.stringify(snapshot);
  };

const onSettlementRequest = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const input = decodeJson(payload.input) as TriggerInput;
  if (!input?.holdId || !input?.cardId) return "ignored: holdId and cardId are required";
  runtime.log(`settlement request for hold ${input.holdId} card ${input.cardId}`);

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: runtime.config.chainSelectorName });
  if (!network) throw new Error(`unknown chain ${runtime.config.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);

  // 1. On-chain: the hold must be open and bound to this exact card.
  const call = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.vaultAddress,
        data: encodeFunctionData({ abi: VAULT_ABI, functionName: "getHold", args: [input.holdId] }),
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  const hold = decodeFunctionResult({ abi: VAULT_ABI, functionName: "getHold", data: bytesToHex(call.data) });
  if (hold.status !== HOLD_OPEN) return `skip: hold is not open (status ${hold.status})`;
  if (hold.cardRef !== keccak256(toBytes(input.cardId))) return "skip: card does not belong to this hold";

  // 2. Off-chain: the real card result, straight from the issuer, agreed by every node.
  const clientId = runtime.getSecret({ id: "AGENTCARD_CLIENT_ID" }).result().value;
  const clientSecret = runtime.getSecret({ id: "AGENTCARD_CLIENT_SECRET" }).result().value;
  const http = new cre.capabilities.HTTPClient();
  const snapshotJson = http
    .sendRequest(runtime, readCardFromIssuer(input.cardId, clientId, clientSecret), consensusIdenticalAggregation<string>())(runtime.config)
    .result();
  const snapshot = JSON.parse(snapshotJson) as CardSnapshot;

  // 3. Decide with the same rules the backend uses.
  const decision = decideSettlement({
    txns: snapshot.txns,
    holdAmountCents: Number(hold.amount / 10_000n),
    holdExpiresAt: Number(hold.expiresAt),
    nowSeconds: Math.floor(runtime.now().getTime() / 1000),
    cardClosed: snapshot.cardClosed,
  });
  runtime.log(`decision: ${decision.action} (${decision.note})`);
  if (decision.action === "wait") return `wait: ${decision.note}`;

  // 4. Signed report -> forwarder -> AnyCheckoutVault.onReport
  const charged = decision.action === "settle" ? BigInt(decision.chargedCents) * 10_000n : 0n;
  const reportData = encodeAbiParameters(parseAbiParameters("address, uint8, bytes32, uint256, bytes32"), [
    runtime.config.vaultAddress,
    decision.action === "settle" ? ACTION_SETTLE : ACTION_REFUND,
    input.holdId,
    charged,
    keccak256(toBytes(decision.ref)),
  ]);
  const report = runtime
    .report({ encodedPayload: hexToBase64(reportData), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
    .result();
  const write = evm
    .writeReport(runtime, { receiver: runtime.config.vaultAddress, report, gasConfig: { gasLimit: runtime.config.gasLimit } })
    .result();
  if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`report write failed: status ${write.txStatus}`);
  const txHash = bytesToHex(write.txHash ?? new Uint8Array(32));
  runtime.log(`${decision.action} written on ${runtime.config.chainSelectorName}: ${txHash}`);
  return `${decision.action}: ${txHash}`;
};

const initWorkflow = () => {
  const http = new cre.capabilities.HTTPCapability();
  // Empty config is fine for simulation. Add authorizedKeys (the backend's key) before deploying.
  return [cre.handler(http.trigger({}), onSettlementRequest)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

main();

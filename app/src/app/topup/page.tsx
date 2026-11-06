"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { erc20Abi, formatUnits, pad, parseUnits, type Hex } from "viem";
import { baseSepolia, sepolia, unichainSepolia } from "viem/chains";
import { createConfig, http, injected, useAccount, useConnect, useDisconnect, WagmiProvider } from "wagmi";
import { readContract, sendTransaction, signTypedData, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { SiteHeader } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AnyCheckoutVaultAbi } from "@/server/abi/AnyCheckoutVault";

type PublicConfig = {
  vault: Hex;
  usdc: Hex;
  chain: { id: number; name: string; rpcUrl: string; explorer: string; isLocal: boolean };
  source: { id: number; name: string; usdc: Hex; cctpDomain: number; rpc: string; explorer: string } | null;
  cctp: { tokenMessenger: Hex; destinationDomain: number };
  uniswapReady: boolean;
};

const TOKEN_MESSENGER_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

const WETH: Record<number, Hex> = {
  84532: "0x4200000000000000000000000000000000000006",
  1301: "0x4200000000000000000000000000000000000006",
  11155111: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
};

function useWagmiConfig(cfg: PublicConfig | null) {
  return useMemo(() => {
    if (!cfg) return null;
    const arc = {
      id: cfg.chain.id,
      name: cfg.chain.name,
      nativeCurrency: cfg.chain.isLocal ? { name: "Ether", symbol: "ETH", decimals: 18 } : { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [cfg.chain.rpcUrl] } },
    } as const;
    return createConfig({
      chains: [arc, baseSepolia, unichainSepolia, sepolia],
      connectors: [injected()],
      transports: {
        [arc.id]: http(cfg.chain.rpcUrl),
        [baseSepolia.id]: http(),
        [unichainSepolia.id]: http(),
        [sepolia.id]: http(),
      },
      ssr: true,
    });
  }, [cfg]);
}

export default function TopupPage() {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [qc] = useState(() => new QueryClient());
  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setCfg);
  }, []);
  const wagmiConfig = useWagmiConfig(cfg);

  return (
    <main className="pb-24">
      <SiteHeader />
      <div className="mx-auto max-w-3xl px-4 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight">Top up with any token</h1>
        <p className="mt-2 text-[var(--muted-foreground)]">
          Swap any token to USDC with Uniswap, then move it into your AnyCheckout vault on Arc with Circle CCTP. Your agent can only spend it within the limits you set below.
        </p>
        {!cfg || !wagmiConfig ? (
          <p className="mt-8 text-[var(--muted-foreground)]">Loading…</p>
        ) : (
          <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={qc}>
              <Flows cfg={cfg} wagmiConfig={wagmiConfig} />
            </QueryClientProvider>
          </WagmiProvider>
        )}
      </div>
    </main>
  );
}

function Flows({ cfg, wagmiConfig }: { cfg: PublicConfig; wagmiConfig: NonNullable<ReturnType<typeof useWagmiConfig>> }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const src = cfg.source;

  const [token, setToken] = useState<string>(src ? WETH[src.id] ?? "" : "");
  const [usdcOut, setUsdcOut] = useState("25");
  const [quote, setQuote] = useState<{ quote: Record<string, unknown>; permitData: Record<string, unknown> | null; routing: string; inLabel: string } | null>(null);
  const [bridgeAmount, setBridgeAmount] = useState("25");
  const [claim, setClaim] = useState<{ status: string; claimTx?: string; error?: string; txHash?: string } | null>(null);
  const [weekly, setWeekly] = useState("200");
  const [perPurchase, setPerPurchase] = useState("100");
  const [deposit, setDeposit] = useState("50");
  const [busy, setBusy] = useState<string | null>(null);

  const step = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message.split("\n")[0].slice(0, 200));
    } finally {
      setBusy(null);
    }
  };

  // poll the CCTP relay status
  useEffect(() => {
    if (!claim?.txHash || !src || ["claimed", "error", "timeout"].includes(claim.status)) return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/cctp/claim?sourceDomain=${src.cctpDomain}&txHash=${claim.txHash}`).then((x) => x.json());
      setClaim((c) => ({ ...c, ...r }));
      if (r.status === "claimed") toast.success("USDC arrived in your Arc vault");
    }, 4000);
    return () => clearInterval(t);
  }, [claim, src]);

  if (!isConnected) {
    return (
      <div className="mt-8 rounded-lg bg-[var(--paper)] p-6">
        <p>Connect the wallet that owns your vault.</p>
        <Button className="mt-4" onClick={() => connect({ connector: connectors[0] })}>Connect wallet</Button>
      </div>
    );
  }

  const getQuote = () =>
    step("quote", async () => {
      if (!src) throw new Error("No source chain configured (UNISWAP_CHAIN_ID)");
      const out = parseUnits(usdcOut, 6).toString();
      const res = await fetch("/api/uniswap/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenIn: token, usdcOut: out, swapper: address }) });
      const q = await res.json();
      if (!res.ok) throw new Error(q.error ?? "No quote");
      const decimals = await readContract(wagmiConfig, { chainId: src.id, address: token as Hex, abi: erc20Abi, functionName: "decimals" });
      const symbol = await readContract(wagmiConfig, { chainId: src.id, address: token as Hex, abi: erc20Abi, functionName: "symbol" }).catch(() => "tokens");
      const input = (q.quote?.input ?? {}) as { amount?: string };
      setQuote({ ...q, inLabel: input.amount ? `${formatUnits(BigInt(input.amount), decimals)} ${symbol}` : "see wallet" });
    });

  const doSwap = () =>
    step("swap", async () => {
      if (!src || !quote || !address) return;
      await switchChain(wagmiConfig, { chainId: src.id });
      const input = (quote.quote.input ?? {}) as { amount?: string };
      const appr = await fetch("/api/uniswap/check_approval", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletAddress: address, token, amount: input.amount }) }).then((r) => r.json());
      if (appr.approval) {
        const h = await sendTransaction(wagmiConfig, { to: appr.approval.to, data: appr.approval.data, value: BigInt(appr.approval.value ?? 0), chainId: src.id });
        await waitForTransactionReceipt(wagmiConfig, { hash: h, chainId: src.id });
        toast.success("Token approved for Permit2");
      }
      let signature: Hex | undefined;
      if (quote.permitData) {
        const pd = quote.permitData as { domain: Record<string, unknown>; types: Record<string, unknown>; values: Record<string, unknown> };
        // The Uniswap API returns the EIP-712 payload for Permit2's PermitSingle.
        const typed = { domain: pd.domain, types: pd.types, primaryType: "PermitSingle", message: pd.values };
        signature = await signTypedData(wagmiConfig, typed as unknown as Parameters<typeof signTypedData>[1]);
      }
      const sw = await fetch("/api/uniswap/swap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quote: quote.quote, signature, permitData: quote.permitData ?? undefined }) }).then((r) => r.json());
      if (!sw.swap) throw new Error(sw.error ?? "Swap build failed");
      const h = await sendTransaction(wagmiConfig, { to: sw.swap.to, data: sw.swap.data, value: BigInt(sw.swap.value ?? 0), chainId: src.id });
      await waitForTransactionReceipt(wagmiConfig, { hash: h, chainId: src.id });
      toast.success(`Swapped to ${usdcOut} USDC on ${src.name}`);
      setBridgeAmount(usdcOut);
    });

  const doBridge = () =>
    step("bridge", async () => {
      if (!src) return;
      await switchChain(wagmiConfig, { chainId: src.id });
      const amount = parseUnits(bridgeAmount, 6);
      const fee = await fetch("/api/cctp/fees").then((r) => r.json());
      // Circle quotes the fast-transfer fee in basis points, possibly fractional (e.g. 1.3).
      const bpsHundredths = BigInt(Math.ceil(Number(fee.bps) * 100));
      const maxFee = bpsHundredths > 0n ? (amount * bpsHundredths + 999_999n) / 1_000_000n + 1n : 0n;
      const a = await writeContract(wagmiConfig, { chainId: src.id, address: src.usdc, abi: erc20Abi, functionName: "approve", args: [cfg.cctp.tokenMessenger, amount] });
      await waitForTransactionReceipt(wagmiConfig, { hash: a, chainId: src.id });
      const vault32 = pad(cfg.vault, { size: 32 });
      const burn = await writeContract(wagmiConfig, {
        chainId: src.id,
        address: cfg.cctp.tokenMessenger,
        abi: TOKEN_MESSENGER_ABI,
        functionName: "depositForBurn",
        args: [amount, cfg.cctp.destinationDomain, vault32, src.usdc, vault32, maxFee, fee.finality],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: burn, chainId: src.id });
      await fetch("/api/cctp/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceDomain: src.cctpDomain, txHash: burn }) });
      setClaim({ status: "waiting_for_attestation", txHash: burn });
      toast.success("Burned on the source chain. Waiting for Circle's attestation.");
    });

  const doPolicy = () =>
    step("policy", async () => {
      await switchChain(wagmiConfig, { chainId: cfg.chain.id });
      const h = await writeContract(wagmiConfig, {
        chainId: cfg.chain.id,
        address: cfg.vault,
        abi: AnyCheckoutVaultAbi,
        functionName: "setPolicy",
        args: [parseUnits(weekly, 6), parseUnits(perPurchase, 6), true],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: h, chainId: cfg.chain.id });
      toast.success("Agent limits saved on Arc");
    });

  const doDeposit = () =>
    step("deposit", async () => {
      await switchChain(wagmiConfig, { chainId: cfg.chain.id });
      const amount = parseUnits(deposit, 6);
      const a = await writeContract(wagmiConfig, { chainId: cfg.chain.id, address: cfg.usdc, abi: erc20Abi, functionName: "approve", args: [cfg.vault, amount] });
      await waitForTransactionReceipt(wagmiConfig, { hash: a, chainId: cfg.chain.id });
      const h = await writeContract(wagmiConfig, { chainId: cfg.chain.id, address: cfg.vault, abi: AnyCheckoutVaultAbi, functionName: "deposit", args: [amount] });
      await waitForTransactionReceipt(wagmiConfig, { hash: h, chainId: cfg.chain.id });
      toast.success(`Deposited ${deposit} USDC`);
    });

  return (
    <div className="mt-8 space-y-6">
      <p className="text-sm text-[var(--muted-foreground)]">
        Connected as <span className="font-mono">{address}</span>.{" "}
        <button className="underline" onClick={() => disconnect()}>Disconnect</button>
      </p>

      <section className="rounded-lg bg-[var(--paper)] p-5">
        <h2 className="font-semibold">1. Swap any token to USDC{src ? ` on ${src.name}` : ""}</h2>
        {!cfg.uniswapReady && <p className="mt-1 text-sm text-[var(--stop)]">Add UNISWAP_API_KEY to app/.env.local to enable quotes.</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px]">
          <div>
            <Label htmlFor="token">Token to pay with (address)</Label>
            <Input id="token" className="bg-white font-mono" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="out">USDC to receive</Label>
            <Input id="out" className="bg-white" inputMode="decimal" value={usdcOut} onChange={(e) => setUsdcOut(e.target.value)} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="outline" disabled={busy !== null} onClick={getQuote}>{busy === "quote" ? "Quoting…" : "Get Uniswap quote"}</Button>
          {quote && (
            <>
              <span className="text-sm">
                Pay about <strong>{quote.inLabel}</strong> ({quote.routing})
              </span>
              <Button disabled={busy !== null} onClick={doSwap}>{busy === "swap" ? "Swapping…" : "Swap with Uniswap"}</Button>
            </>
          )}
        </div>
      </section>

      <section className="rounded-lg bg-[var(--paper)] p-5">
        <h2 className="font-semibold">2. Move USDC into your vault on {cfg.chain.name}</h2>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">Circle CCTP burns it on {src?.name ?? "the source chain"} and mints it straight into the vault, credited to you.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="bridge">USDC amount</Label>
            <Input id="bridge" className="w-32 bg-white" inputMode="decimal" value={bridgeAmount} onChange={(e) => setBridgeAmount(e.target.value)} />
          </div>
          <Button disabled={busy !== null || !src} onClick={doBridge}>{busy === "bridge" ? "Bridging…" : "Bridge to vault"}</Button>
        </div>
        {claim && (
          <p className="mt-3 text-sm">
            {claim.status === "claimed" ? "Arrived in your vault." : claim.status === "error" || claim.status === "timeout" ? `Relay problem: ${claim.error}` : "Waiting for Circle's attestation…"}{" "}
            {claim.claimTx && cfg.chain.explorer && (
              <a className="underline" target="_blank" rel="noreferrer" href={`${cfg.chain.explorer}/tx/${claim.claimTx}`}>View on Arc</a>
            )}
          </p>
        )}
      </section>

      <section className="rounded-lg bg-[var(--paper)] p-5">
        <h2 className="font-semibold">Already have USDC on {cfg.chain.name}?</h2>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="dep">USDC amount</Label>
            <Input id="dep" className="w-32 bg-white" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </div>
          <Button variant="outline" disabled={busy !== null} onClick={doDeposit}>{busy === "deposit" ? "Depositing…" : "Deposit into vault"}</Button>
        </div>
      </section>

      <section className="rounded-lg bg-[var(--paper)] p-5">
        <h2 className="font-semibold">Your agent&apos;s limits</h2>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">One signature now, so your agent never needs one per purchase. Anything above these needs your World ID.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="wk">Weekly allowance ($)</Label>
            <Input id="wk" className="w-32 bg-white" inputMode="decimal" value={weekly} onChange={(e) => setWeekly(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pp">Per purchase ($)</Label>
            <Input id="pp" className="w-32 bg-white" inputMode="decimal" value={perPurchase} onChange={(e) => setPerPurchase(e.target.value)} />
          </div>
          <Button variant="outline" disabled={busy !== null} onClick={doPolicy}>{busy === "policy" ? "Saving…" : "Save limits"}</Button>
        </div>
      </section>
    </div>
  );
}

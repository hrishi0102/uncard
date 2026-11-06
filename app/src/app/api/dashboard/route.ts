import { NextResponse } from "next/server";
import * as chain from "@/server/chain";
import { config, modes } from "@/server/config";
import { ensureBackgroundLoop, listIntents } from "@/server/intents";
import { listMerchants } from "@/server/merchants";
import { ensureDemoUser } from "@/server/users";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!chain.isConfigured()) {
    return NextResponse.json({ configured: false, error: "Vault not configured. Run `npm run local:setup` (see README)." }, { status: 503 });
  }
  try {
    const user = await ensureDemoUser();
    ensureBackgroundLoop();
    const [account, walletUsdc] = await Promise.all([
      chain.readAccount(user.wallet),
      chain.readUsdcBalance(user.wallet).catch(() => null),
    ]);
    return NextResponse.json({
      configured: true,
      modes: modes(),
      user: { name: user.name, wallet: user.wallet, world: user.world ? { sub: user.world.sub, linkedAt: user.world.linkedAt, acr: user.world.acr } : null },
      account,
      walletUsdcCents: walletUsdc,
      intents: listIntents(user.id),
      merchants: listMerchants(),
      contracts: { vault: config.chain.vault, usdc: config.chain.usdc, chainId: config.chain.id, chainName: config.chain.name, explorer: config.chain.explorerUrl || null },
      mcp: { url: `${config.appUrl}/api/mcp`, agentKey: user.agentKeys[0]?.key },
      isLocalChain: config.chain.isLocal,
    });
  } catch (e) {
    return NextResponse.json({ configured: true, error: (e as Error).message }, { status: 500 });
  }
}

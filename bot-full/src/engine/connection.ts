import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadConfig, USDC_MINT } from "../config.js";
import { log } from "../logger.js";
import { getWalletPublicKey } from "./wallet.js";

let _conn: Connection | null = null;

export function getConnection(): Connection {
  if (!_conn) {
    const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
    _conn = new Connection(cfg.rpcUrl, "confirmed");
  }
  return _conn;
}

export function resetConnection(): void {
  _conn = null;
}

export type BalanceSnapshot = {
  wallet: string;
  sol: number;
  usdc: number;
  sol_usd: number;
  usdc_usd: number;
  total_usd: number;
  error?: string;
};

function walletPubkey(): PublicKey {
  try {
    return getWalletPublicKey();
  } catch {
    return loadConfig({ requireTelegram: false, skipWallet: true }).walletPublicKey;
  }
}

export async function getBalances(solUsdHint = 0): Promise<BalanceSnapshot> {
  const pubkey = walletPubkey();
  const wallet = pubkey.toBase58();
  try {
    const conn = getConnection();
    const lamports = await conn.getBalance(pubkey);
    const sol = lamports / LAMPORTS_PER_SOL;
    let usdc = 0;
    try {
      const accounts = await conn.getParsedTokenAccountsByOwner(pubkey, {
        mint: new PublicKey(USDC_MINT),
      });
      usdc = accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    } catch (e) {
      log("balance", `USDC read failed: ${(e as Error).message}`, "warn");
    }
    const sol_usd = sol * solUsdHint;
    const usdc_usd = usdc;
    return {
      wallet,
      sol,
      usdc,
      sol_usd,
      usdc_usd,
      total_usd: sol_usd + usdc_usd,
    };
  } catch (e) {
    return {
      wallet,
      sol: 0,
      usdc: 0,
      sol_usd: 0,
      usdc_usd: 0,
      total_usd: 0,
      error: (e as Error).message,
    };
  }
}

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadConfig, USDC_MINT } from "../config.js";
import { log } from "../logger.js";
import { getWalletPublicKey } from "./wallet.js";
import { RpcFailover, parseRpcUrls, isValidRpcUrl, RPC_COOLDOWN_MS } from "./rpc-failover.js";

let _conn: Connection | null = null;
let _failover: RpcFailover | null = null;

const PUBLIC_FALLBACK = "https://api.mainnet-beta.solana.com";

/** Test / ops: replace the pool (never log URLs). */
export function getRpcFailover(): RpcFailover | null {
  return _failover;
}

export function getConnection(): Connection {
  if (!_conn) {
    const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
    let urls = (cfg.rpcUrls?.length ? cfg.rpcUrls : parseRpcUrls(undefined, cfg.rpcUrl)).filter(isValidRpcUrl);
    if (!urls.length) urls = parseRpcUrls(undefined, undefined);
    // Extra public fallback when only a private RPC is configured (helps 429 / bad secondary slots)
    if (urls.length === 1 && !urls[0]!.includes("mainnet-beta.solana.com")) {
      urls = [...urls, PUBLIC_FALLBACK];
    }
    _failover = new RpcFailover(urls, { cooldownMs: RPC_COOLDOWN_MS });
    _conn = new Connection(urls[0]!, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: (input, init) => _failover!.fetch(input, init),
    });
    if (urls.length > 1) log("rpc", `${urls.length} endpoints · active ${_failover.label()}`);
  }
  return _conn;
}

export function resetConnection(): void {
  _conn = null;
  _failover = null;
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

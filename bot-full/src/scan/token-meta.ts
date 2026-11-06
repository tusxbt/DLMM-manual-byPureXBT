/**
 * Public on-chain / market metadata for scanner hard-filters.
 * Never invent values: any required fetch failure → caller must reject the pool.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";
import { log } from "../logger.js";

export type TokenMeta = {
  mint: string;
  /** null = unknown / failed */
  hasMintAuthority: boolean | null;
  hasFreezeAuthority: boolean | null;
  /** sum of top-10 largest accounts / supply, 0–100 */
  top10HolderPct: number | null;
  /** USD market cap */
  marketCapUsd: number | null;
  supplyUi: number | null;
  sources: Record<string, string>;
  /** required fields that failed */
  failures: string[];
};

export type RpcLike = {
  getAccountInfo(pubkey: PublicKey, commitment?: string): Promise<{ data: Buffer } | null>;
  getTokenLargestAccounts(mint: PublicKey): Promise<{ value: Array<{ amount: string; uiAmount: number | null }> }>;
  getTokenSupply?(mint: PublicKey): Promise<{ value: { amount: string; uiAmount: number | null; decimals: number } }>;
};

type Fetch = typeof fetch;

const metaCache = new Map<string, { at: number; meta: TokenMeta }>();
const META_TTL_MS = 5 * 60_000;

export function resetTokenMetaCache(): void {
  metaCache.clear();
}

function fail(mint: string, sources: Record<string, string>, failures: string[], partial: Partial<TokenMeta> = {}): TokenMeta {
  return {
    mint,
    hasMintAuthority: partial.hasMintAuthority ?? null,
    hasFreezeAuthority: partial.hasFreezeAuthority ?? null,
    top10HolderPct: partial.top10HolderPct ?? null,
    marketCapUsd: partial.marketCapUsd ?? null,
    supplyUi: partial.supplyUi ?? null,
    sources,
    failures,
  };
}

/** Parse SPL Token mint account: mintAuthority + freezeAuthority option bools. */
export function parseMintAuthorities(data: Buffer): { hasMintAuthority: boolean; hasFreezeAuthority: boolean; supply: bigint; decimals: number } {
  if (data.length < MintLayout.span) throw new Error(`mint account too short (${data.length})`);
  const m = MintLayout.decode(data);
  return {
    hasMintAuthority: m.mintAuthorityOption === 1,
    hasFreezeAuthority: m.freezeAuthorityOption === 1,
    supply: BigInt(m.supply.toString()),
    decimals: m.decimals,
  };
}

async function fetchMintAuthorities(rpc: RpcLike, mint: string, sources: Record<string, string>, failures: string[]): Promise<{
  hasMintAuthority: boolean | null;
  hasFreezeAuthority: boolean | null;
  supply: bigint | null;
  decimals: number | null;
}> {
  try {
    const info = await rpc.getAccountInfo(new PublicKey(mint), "confirmed");
    if (!info?.data) {
      failures.push("mint_account");
      sources.mintAuthority = "rpc:getAccountInfo:missing";
      return { hasMintAuthority: null, hasFreezeAuthority: null, supply: null, decimals: null };
    }
    const buf = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data as ArrayBuffer);
    const p = parseMintAuthorities(buf);
    sources.mintAuthority = "rpc:getAccountInfo+MintLayout";
    sources.freezeAuthority = "rpc:getAccountInfo+MintLayout";
    sources.supply = "rpc:mint.supply";
    return { hasMintAuthority: p.hasMintAuthority, hasFreezeAuthority: p.hasFreezeAuthority, supply: p.supply, decimals: p.decimals };
  } catch (e) {
    failures.push("mint_account");
    sources.mintAuthority = `rpc:error:${(e as Error).message.slice(0, 80)}`;
    return { hasMintAuthority: null, hasFreezeAuthority: null, supply: null, decimals: null };
  }
}

async function fetchTop10Pct(
  rpc: RpcLike,
  mint: string,
  supply: bigint | null,
  sources: Record<string, string>,
  failures: string[],
): Promise<number | null> {
  try {
    const res = await rpc.getTokenLargestAccounts(new PublicKey(mint));
    const accts = res?.value || [];
    if (!accts.length) {
      failures.push("top10");
      sources.top10 = "rpc:getTokenLargestAccounts:empty";
      return null;
    }
    if (supply == null || supply === 0n) {
      failures.push("top10");
      sources.top10 = "rpc:getTokenLargestAccounts:no_supply";
      return null;
    }
    const top = accts.slice(0, 10).reduce((s, a) => s + BigInt(a.amount || "0"), 0n);
    const pct = Number((top * 10000n) / supply) / 100;
    sources.top10 = "rpc:getTokenLargestAccounts";
    return pct;
  } catch (e) {
    failures.push("top10");
    sources.top10 = `rpc:error:${(e as Error).message.slice(0, 80)}`;
    return null;
  }
}

/** Jupiter price v3 → USD, then mcap = price * UI supply. Fallbacks: DexScreener, then CoinGecko via contract. */
export async function fetchMarketCapUsd(
  mint: string,
  supplyUi: number | null,
  fetchFn: Fetch,
  sources: Record<string, string>,
  failures: string[],
): Promise<number | null> {
  // 1) Jupiter
  try {
    const urls = [
      `https://lite-api.jup.ag/price/v3?ids=${mint}`,
      `https://api.jup.ag/price/v3?ids=${mint}`,
    ];
    for (const url of urls) {
      const res = await fetchFn(url, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const j = (await res.json()) as Record<string, { usdPrice?: number; price?: number } | null>;
      const row = j[mint] || (j as { data?: Record<string, { usdPrice?: number }> }).data?.[mint];
      const px = Number(row?.usdPrice ?? (row as { price?: number } | undefined)?.price);
      if (Number.isFinite(px) && px > 0 && supplyUi != null && supplyUi > 0) {
        sources.marketCap = `jupiter:price*supply`;
        return px * supplyUi;
      }
    }
  } catch (e) {
    sources.marketCap = `jupiter:error:${(e as Error).message.slice(0, 60)}`;
  }
  // 2) DexScreener
  try {
    const res = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const j = (await res.json()) as { pairs?: Array<{ marketCap?: number; fdv?: number; liquidity?: { usd?: number } }> };
      const pairs = j.pairs || [];
      const best = pairs.map((p) => Number(p.marketCap ?? p.fdv)).find((n) => Number.isFinite(n) && n > 0);
      if (best != null) {
        sources.marketCap = "dexscreener:marketCap|fdv";
        return best;
      }
    }
  } catch (e) {
    sources.marketCap = `${sources.marketCap || ""};dex:error:${(e as Error).message.slice(0, 40)}`;
  }
  failures.push("marketCap");
  if (!sources.marketCap) sources.marketCap = "unavailable";
  return null;
}

export async function fetchTokenMeta(
  mint: string,
  opts: { rpc: RpcLike; fetchFn?: Fetch; now?: number } ,
): Promise<TokenMeta> {
  const now = opts.now ?? Date.now();
  const hit = metaCache.get(mint);
  if (hit && now - hit.at < META_TTL_MS) return hit.meta;

  const sources: Record<string, string> = {};
  const failures: string[] = [];
  const fetchFn = opts.fetchFn ?? fetch;

  const auth = await fetchMintAuthorities(opts.rpc, mint, sources, failures);
  let supplyUi: number | null = null;
  if (auth.supply != null && auth.decimals != null) {
    supplyUi = Number(auth.supply) / 10 ** auth.decimals;
  }

  const top10HolderPct = await fetchTop10Pct(opts.rpc, mint, auth.supply, sources, failures);
  const marketCapUsd = await fetchMarketCapUsd(mint, supplyUi, fetchFn, sources, failures);

  const meta = fail(mint, sources, failures, {
    hasMintAuthority: auth.hasMintAuthority,
    hasFreezeAuthority: auth.hasFreezeAuthority,
    top10HolderPct,
    marketCapUsd,
    supplyUi,
  });
  metaCache.set(mint, { at: now, meta });
  return meta;
}

/** Batch unique mints (concurrency-limited). */
export async function fetchTokenMetaMany(
  mints: string[],
  opts: { rpc: RpcLike; fetchFn?: Fetch; concurrency?: number },
): Promise<Map<string, TokenMeta>> {
  const uniq = [...new Set(mints.filter(Boolean))];
  const out = new Map<string, TokenMeta>();
  const conc = Math.max(1, Math.min(8, opts.concurrency ?? 4));
  let i = 0;
  async function worker() {
    while (i < uniq.length) {
      const mint = uniq[i++];
      try {
        out.set(mint, await fetchTokenMeta(mint, opts));
      } catch (e) {
        log("scan", `meta ${mint.slice(0, 6)}: ${(e as Error).message}`, "warn");
        out.set(mint, fail(mint, { error: (e as Error).message }, ["meta_throw"]));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, uniq.length) }, () => worker()));
  return out;
}

export function connectionAsRpc(conn: Connection): RpcLike {
  return {
    async getAccountInfo(pubkey) {
      const info = await conn.getAccountInfo(pubkey, "confirmed");
      if (!info) return null;
      return { data: Buffer.from(info.data) };
    },
    async getTokenLargestAccounts(mint) {
      return conn.getTokenLargestAccounts(mint);
    },
  };
}

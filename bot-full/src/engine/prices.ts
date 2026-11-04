import { log } from "../logger.js";
import { SOL_MINT, loadConfig } from "../config.js";

/**
 * Jupiter Price API v3. (v2 at api.jup.ag/price/v2 now returns 404 → every USD value was 0.)
 * With JUPITER_API_KEY → api.jup.ag, else free lite-api.jup.ag.
 */
export function priceApiBase(): { url: string; headers: Record<string, string> } {
  let key = "";
  try {
    key = loadConfig({ requireTelegram: false, skipWallet: true }).jupiterApiKey || "";
  } catch {
    /* config not loaded */
  }
  return key
    ? { url: "https://api.jup.ag/price/v3", headers: { accept: "application/json", "x-api-key": key } }
    : { url: "https://lite-api.jup.ag/price/v3", headers: { accept: "application/json" } };
}

/** Parse v3 `{mint:{usdPrice}}` (also tolerates v2 `{data:{mint:{price}}}`). */
export function parsePriceResponse(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const root = (data && typeof data === "object" && "data" in (data as object) ? (data as { data: unknown }).data : data) as Record<string, { usdPrice?: unknown; price?: unknown } | null>;
  for (const [mint, row] of Object.entries(root || {})) {
    const p = Number(row?.usdPrice ?? row?.price);
    if (Number.isFinite(p) && p > 0) out[mint] = p;
  }
  return out;
}

// ── shared short cache (all users/positions) + Jupiter backoff + fallbacks ─────────────
export const PRICE_TTL_MS = 12_000;
const STALE_MS = 5 * 60_000; // last-resort stale value when every source fails
const cache = new Map<string, { px: number; at: number; src: string }>();
const inflight = new Map<string, Promise<Record<string, number>>>();
let jupBlockedUntil = 0;
type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function resetPriceStateForTests(f?: Fetch): void {
  cache.clear();
  inflight.clear();
  jupBlockedUntil = 0;
  fetchImpl = f ?? ((...a) => fetch(...a));
}
export function priceSourceOf(mint: string): string | null {
  return cache.get(mint)?.src ?? null;
}

/** Retry-After (seconds or HTTP date) → ms, else exponential backoff. */
export function backoffMs(attempt: number, retryAfter: string | null, now = Date.now()): number {
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s >= 0) return Math.min(30_000, s * 1000);
    const d = Date.parse(retryAfter);
    if (Number.isFinite(d)) return Math.min(30_000, Math.max(0, d - now));
  }
  return Math.min(8_000, 500 * 2 ** attempt);
}

async function jupiter(mints: string[]): Promise<Record<string, number>> {
  if (Date.now() < jupBlockedUntil) throw new Error("Jupiter cooldown (429)");
  const { url, headers } = priceApiBase();
  const out: Record<string, number> = {};
  for (let i = 0; i < mints.length; i += 50) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${url}?ids=${mints.slice(i, i + 50).join(",")}`, { headers });
      if (res.ok) {
        Object.assign(out, parsePriceResponse(await res.json()));
        break;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const wait = backoffMs(attempt, res.headers.get("retry-after"));
        if (res.status === 429) jupBlockedUntil = Date.now() + wait;
        if (wait > 4_000) throw new Error(`HTTP ${res.status} (retry-after ${Math.round(wait / 1000)}s)`); // don't stall UI; fallbacks next
        await sleep(wait);
        continue;
      }
      if (res.status === 429) jupBlockedUntil = Date.now() + backoffMs(attempt + 1, res.headers.get("retry-after"));
      throw new Error(`HTTP ${res.status}`);
    }
  }
  return out;
}

/** Meteora datapi: pools?query=<mint> → token_x/token_y.price. */
async function meteora(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    mints.map(async (m) => {
      try {
        const res = await fetchImpl(`https://dlmm.datapi.meteora.ag/pools?query=${m}&page_size=3`, { headers: { accept: "application/json" } });
        if (!res.ok) return;
        const j = (await res.json()) as { data?: Array<{ token_x?: { address?: string; price?: number }; token_y?: { address?: string; price?: number } }> };
        for (const p of j.data || [])
          for (const t of [p.token_x, p.token_y]) {
            const px = Number(t?.price);
            if (t?.address === m && Number.isFinite(px) && px > 0 && out[m] == null) out[m] = px;
          }
      } catch {
        /* next source */
      }
    }),
  );
  return out;
}

/** DexScreener batch (≤30 mints/req): highest-liquidity pair where mint is base. */
async function dexscreener(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const best: Record<string, number> = {};
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(",")}`, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      for (const p of (await res.json()) as Array<{ baseToken?: { address?: string }; priceUsd?: string; liquidity?: { usd?: number } }>) {
        const m = p.baseToken?.address;
        const px = Number(p.priceUsd);
        const liq = Number(p.liquidity?.usd ?? 0);
        if (m && Number.isFinite(px) && px > 0 && (best[m] == null || liq > best[m])) {
          best[m] = liq;
          out[m] = px;
        }
      }
    } catch {
      /* next */
    }
  }
  return out;
}

async function fetchFresh(mints: string[]): Promise<Record<string, number>> {
  const got: Record<string, number> = {};
  const put = (r: Record<string, number>, src: string) => {
    for (const [m, px] of Object.entries(r)) {
      if (got[m] != null || !mints.includes(m)) continue;
      got[m] = px;
      cache.set(m, { px, at: Date.now(), src });
    }
  };
  const sources: Array<[string, (m: string[]) => Promise<Record<string, number>>]> = [["jupiter", jupiter], ["meteora", meteora], ["dexscreener", dexscreener]];
  for (const [name, fn] of sources) {
    const missing = mints.filter((m) => got[m] == null);
    if (!missing.length) break;
    try {
      put(await fn(missing), name);
    } catch (e) {
      log("prices", `${name} price failed: ${(e as Error).message}`, "warn");
    }
  }
  return got;
}

/** USD prices, batched + cached ~12s and shared by every user/position. Missing = unknown (never 0). */
export async function getUsdPrices(mints: string[]): Promise<Record<string, number>> {
  const unique = [...new Set(mints.filter(Boolean))];
  if (!unique.length) return {};
  const now = Date.now();
  const out: Record<string, number> = {};
  const need: string[] = [];
  for (const m of unique) {
    const c = cache.get(m);
    if (c && now - c.at < PRICE_TTL_MS) out[m] = c.px;
    else need.push(m);
  }
  if (need.length) {
    const key = need.slice().sort().join(",");
    let p = inflight.get(key);
    if (!p) {
      p = fetchFresh(need).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    Object.assign(out, await p);
    for (const m of need) {
      const c = cache.get(m);
      if (out[m] == null && c && now - c.at < STALE_MS) out[m] = c.px; // stale fallback
    }
  }
  return out;
}

/** Throws if SOL price unknown — callers use it for USD caps, so 0 must never pass silently. */
export async function getSolUsd(): Promise<number> {
  const p = (await getUsdPrices([SOL_MINT]))[SOL_MINT];
  if (!p) throw new Error("Harga SOL/USD tidak tersedia (Jupiter price) — cap USD tidak bisa dicek, aksi ditolak.");
  return p;
}

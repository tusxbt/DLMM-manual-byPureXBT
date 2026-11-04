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

export async function getUsdPrices(mints: string[]): Promise<Record<string, number>> {
  const unique = [...new Set(mints.filter(Boolean))];
  if (!unique.length) return {};
  const { url, headers } = priceApiBase();
  try {
    const out: Record<string, number> = {};
    for (let i = 0; i < unique.length; i += 50) {
      const res = await fetch(`${url}?ids=${unique.slice(i, i + 50).join(",")}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      Object.assign(out, parsePriceResponse(await res.json()));
    }
    return out;
  } catch (e) {
    log("prices", `Jupiter price failed: ${(e as Error).message}`, "warn");
    return {};
  }
}

/** Throws if SOL price unknown — callers use it for USD caps, so 0 must never pass silently. */
export async function getSolUsd(): Promise<number> {
  const p = (await getUsdPrices([SOL_MINT]))[SOL_MINT];
  if (!p) throw new Error("Harga SOL/USD tidak tersedia (Jupiter price) — cap USD tidak bisa dicek, aksi ditolak.");
  return p;
}

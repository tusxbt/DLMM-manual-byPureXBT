/** Token supply (UI units, correct decimals) via getTokenSupply, cached per mint (10 min). */
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection.js";

const cache = new Map<string, { v: number; at: number }>();
const TTL = 10 * 60_000;

export async function getSupplyUi(mint: string): Promise<number | null> {
  const c = cache.get(mint);
  if (c && Date.now() - c.at < TTL) return c.v;
  try {
    const r = await getConnection().getTokenSupply(new PublicKey(mint));
    const v = Number(r.value.uiAmountString ?? r.value.uiAmount);
    if (!Number.isFinite(v) || v <= 0) return null;
    cache.set(mint, { v, at: Date.now() });
    return v;
  } catch {
    return null;
  }
}

export function setSupplyForTests(mint: string, v: number): void {
  cache.set(mint, { v, at: Date.now() });
}

/** Market cap = price (quote per token) × quote USD × supply. null if anything unknown. */
export function marketCap(priceQuote: number | null | undefined, quoteUsd: number | null | undefined, supply: number | null | undefined): number | null {
  if (!priceQuote || !quoteUsd || !supply) return null;
  const v = priceQuote * quoteUsd * supply;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** $1.2M style. */
export function fmtCompactUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  const [d, s] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  const n = v / d;
  return `$${n >= 100 || !s ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2).replace(/\.?0+$/, "")}${s}`;
}

export function mcRangeText(min: number | null, max: number | null, now: number | null): string {
  if (min == null && max == null) return "MC n/a";
  return `MC ${fmtCompactUsd(min)} – ${fmtCompactUsd(max)}${now != null ? ` (now ${fmtCompactUsd(now)})` : ""}`;
}

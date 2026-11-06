/**
 * Display FX: convert stored USD amounts into the user's chosen currency.
 * Rates are "units of currency per 1 USD". Cache a few minutes; fail soft to last/fallback.
 */
import { getSolUsd } from "./prices.js";
import { log } from "../logger.js";

export type DisplayCurrency = "USD" | "IDR" | "SOL";

export type CurrencyMeta = {
  code: DisplayCurrency;
  /** prefix/symbol shown before the number */
  symbol: string;
  /** suffix after number (e.g. " SOL"); empty for fiat */
  suffix: string;
  decimals: number;
  label: string;
};

/** Registry — append here to add a currency (plus a rate fetcher below). */
export const CURRENCIES: Record<DisplayCurrency, CurrencyMeta> = {
  USD: { code: "USD", symbol: "$", suffix: "", decimals: 2, label: "USD ($)" },
  IDR: { code: "IDR", symbol: "Rp", suffix: "", decimals: 0, label: "IDR (Rp)" },
  SOL: { code: "SOL", symbol: "", suffix: " SOL", decimals: 4, label: "SOL" },
};

export const DISPLAY_CURRENCY_CODES = Object.keys(CURRENCIES) as DisplayCurrency[];

export type FxRates = Record<DisplayCurrency, number>;

export const FX_TTL_MS = 5 * 60_000;
const FALLBACK: FxRates = { USD: 1, IDR: 16_200, SOL: 1 / 150 };

let cache: { rates: FxRates; at: number; src: string } = { rates: { ...FALLBACK }, at: 0, src: "fallback" };
let inflight: Promise<FxRates> | null = null;
type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);

export function resetFxForTests(f?: Fetch): void {
  cache = { rates: { ...FALLBACK }, at: 0, src: "fallback" };
  inflight = null;
  fetchImpl = f ?? ((...a) => fetch(...a));
}

export function getFxRatesCached(): FxRates {
  return cache.rates;
}

export function fxCacheMeta(): { at: number; src: string; ageMs: number } {
  return { at: cache.at, src: cache.src, ageMs: Date.now() - cache.at };
}

export function coerceDisplayCurrency(v: unknown): DisplayCurrency {
  const c = String(v || "USD").toUpperCase();
  return (DISPLAY_CURRENCY_CODES.includes(c as DisplayCurrency) ? c : "USD") as DisplayCurrency;
}

/** USD amount → display units. */
export function convertFromUsd(usd: number, code: DisplayCurrency = "USD", rates: FxRates = getFxRatesCached()): number {
  const r = rates[code] ?? 1;
  return usd * r;
}

export function formatConverted(n: number, code: DisplayCurrency, sign = false): string {
  const meta = CURRENCIES[code] ?? CURRENCIES.USD;
  const abs = Math.abs(n);
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: meta.decimals,
    maximumFractionDigits: meta.decimals,
  });
  const signed = sign ? (n >= 0 ? "+" : "−") : n < 0 ? "−" : "";
  if (meta.suffix) return `${signed}${body}${meta.suffix}`;
  return `${signed}${meta.symbol}${body}`;
}

/** Compact for chart pills. */
export function formatConvertedShort(n: number, code: DisplayCurrency): string {
  const meta = CURRENCIES[code] ?? CURRENCIES.USD;
  const a = Math.abs(n);
  const sign = n >= 0 ? "+" : "−";
  if (code === "SOL") {
    const body = a >= 10 ? a.toFixed(2) : a.toFixed(4);
    return `${sign}${body} SOL`;
  }
  if (code === "IDR") {
    if (a >= 1_000_000) return `${sign}Rp${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}jt`;
    if (a >= 1_000) return `${sign}Rp${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1)}rb`;
    return `${sign}Rp${Math.round(a)}`;
  }
  // USD
  const body = a >= 1000 ? `$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : `$${a.toFixed(a >= 100 ? 0 : 2)}`;
  return `${sign}${body}`;
}

async function fetchIdrPerUsd(): Promise<number | null> {
  const urls = [
    "https://api.frankfurter.app/latest?from=USD&to=IDR",
    "https://open.er-api.com/v6/latest/USD",
  ];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const j = (await res.json()) as { rates?: { IDR?: number }; conversion_rates?: { IDR?: number } };
      const idr = Number(j.rates?.IDR ?? j.conversion_rates?.IDR);
      if (Number.isFinite(idr) && idr > 1000) return idr;
    } catch (e) {
      log("fx", `IDR fetch ${url}: ${(e as Error).message}`, "warn");
    }
  }
  return null;
}

/** Refresh rates (USD=1, IDR per USD, SOL per USD). Uses cache within FX_TTL_MS. */
export async function refreshFxRates(force = false): Promise<FxRates> {
  const now = Date.now();
  if (!force && now - cache.at < FX_TTL_MS) return cache.rates;
  if (inflight) return inflight;
  inflight = (async () => {
    const next: FxRates = { ...cache.rates };
    let src = cache.src;
    try {
      const solUsd = await getSolUsd();
      if (solUsd > 0) next.SOL = 1 / solUsd;
    } catch (e) {
      log("fx", `SOL rate: ${(e as Error).message}`, "warn");
    }
    const idr = await fetchIdrPerUsd();
    if (idr != null) next.IDR = idr;
    next.USD = 1;
    src = `live·${new Date().toISOString().slice(11, 19)}Z`;
    cache = { rates: next, at: Date.now(), src };
    return next;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function ensureFxRates(): Promise<FxRates> {
  try {
    return await refreshFxRates(false);
  } catch {
    return getFxRatesCached();
  }
}

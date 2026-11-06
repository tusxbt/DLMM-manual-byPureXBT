/**
 * User-facing money formatting in the chosen display currency (default USD).
 * Amounts in the store stay USD; convert at display time.
 */
import { loadSettings } from "./store/settings.js";
import {
  coerceDisplayCurrency,
  convertFromUsd,
  formatConverted,
  formatConvertedShort,
  getFxRatesCached,
  type DisplayCurrency,
  type FxRates,
  CURRENCIES,
} from "./engine/fx.js";

export type { DisplayCurrency, FxRates };
export { CURRENCIES, convertFromUsd, formatConverted, formatConvertedShort, getFxRatesCached };

export function currentDisplayCurrency(): DisplayCurrency {
  try {
    return coerceDisplayCurrency(loadSettings().displayCurrency);
  } catch {
    return "USD";
  }
}

/** Optional override for card renderers (set just before render, cleared after). */
let override: { currency: DisplayCurrency; rates: FxRates } | null = null;

export function withDisplayMoney<T>(currency: DisplayCurrency, rates: FxRates, fn: () => T): T {
  const prev = override;
  override = { currency, rates };
  try {
    return fn();
  } finally {
    override = prev;
  }
}

export function activeDisplay(): { currency: DisplayCurrency; rates: FxRates } {
  return override ?? { currency: currentDisplayCurrency(), rates: getFxRatesCached() };
}

/** Format a USD-denominated amount in the user's display currency. */
export function fmtMoney(
  usd: number | null | undefined,
  opts: { sign?: boolean; currency?: DisplayCurrency; rates?: FxRates; na?: string } = {},
): string {
  if (usd == null || !Number.isFinite(usd)) return opts.na ?? "n/a";
  const act = activeDisplay();
  const code = opts.currency ?? act.currency;
  const rates = opts.rates ?? act.rates;
  return formatConverted(convertFromUsd(usd, code, rates), code, opts.sign === true);
}

export function fmtMoneyShort(
  usd: number,
  opts: { currency?: DisplayCurrency; rates?: FxRates } = {},
): string {
  const act = activeDisplay();
  const code = opts.currency ?? act.currency;
  const rates = opts.rates ?? act.rates;
  return formatConvertedShort(convertFromUsd(usd, code, rates), code);
}

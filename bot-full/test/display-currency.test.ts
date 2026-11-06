import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.DATA_DIR = fs.mkdtempSync("/tmp/fx-");

import {
  convertFromUsd,
  formatConverted,
  formatConvertedShort,
  coerceDisplayCurrency,
  refreshFxRates,
  resetFxForTests,
  getFxRatesCached,
  CURRENCIES,
  DISPLAY_CURRENCY_CODES,
  FX_TTL_MS,
} from "../src/engine/fx.js";
import { loadSettings, saveSettings } from "../src/store/settings.js";
import { fmtMoney, withDisplayMoney, currentDisplayCurrency } from "../src/display-money.js";
import { renderSummaryCard } from "../src/render/daily-card.js";
import { money as dailyMoney } from "../src/render/daily-card.js";

test("currency registry + coerce", () => {
  assert.deepEqual(DISPLAY_CURRENCY_CODES.sort(), ["IDR", "SOL", "USD"].sort());
  assert.equal(coerceDisplayCurrency("idr"), "IDR");
  assert.equal(coerceDisplayCurrency("nope"), "USD");
  assert.equal(CURRENCIES.IDR.symbol, "Rp");
});

test("convert + format USD/IDR/SOL", () => {
  const rates = { USD: 1, IDR: 16_000, SOL: 1 / 200 };
  assert.equal(convertFromUsd(10, "USD", rates), 10);
  assert.equal(convertFromUsd(10, "IDR", rates), 160_000);
  assert.ok(Math.abs(convertFromUsd(200, "SOL", rates) - 1) < 1e-9);
  assert.equal(formatConverted(12.5, "USD", true), "+$12.50");
  assert.match(formatConverted(16000, "IDR", true), /^\+Rp/);
  assert.match(formatConverted(1.2345, "SOL", true), /SOL$/);
  assert.match(formatConvertedShort(42.5, "USD"), /^\+\$/);
  assert.match(formatConvertedShort(-0.5, "SOL"), /SOL$/);
});

test("settings persist displayCurrency; default USD", () => {
  const st = loadSettings();
  assert.equal(st.displayCurrency, "USD");
  st.displayCurrency = "IDR";
  saveSettings(st);
  assert.equal(loadSettings().displayCurrency, "IDR");
  assert.equal(currentDisplayCurrency(), "IDR");
  st.displayCurrency = "USD";
  saveSettings(st);
});

test("refreshFxRates uses public IDR API + SOL price (mocked)", async () => {
  const { resetPriceStateForTests } = await import("../src/engine/prices.js");
  const fakeFetch = async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("frankfurter") || u.includes("er-api")) {
      return new Response(JSON.stringify({ rates: { IDR: 15_500 }, conversion_rates: { IDR: 15_500 } }), { status: 200 });
    }
    if (u.includes("jup.ag") || u.includes("price")) {
      return new Response(JSON.stringify({ "So11111111111111111111111111111111111111112": { usdPrice: 100 } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  resetFxForTests(fakeFetch);
  resetPriceStateForTests(fakeFetch);
  const rates = await refreshFxRates(true);
  assert.equal(rates.USD, 1);
  assert.equal(rates.IDR, 15_500);
  assert.ok(Math.abs(rates.SOL - 0.01) < 1e-9, `SOL rate ${rates.SOL}`);
  const again = await refreshFxRates(false);
  assert.equal(again.IDR, 15_500);
  assert.ok(FX_TTL_MS >= 60_000);
});

test("fmtMoney + card render follow withDisplayMoney override", () => {
  const rates = { USD: 1, IDR: 10_000, SOL: 0.01 };
  withDisplayMoney("IDR", rates, () => {
    assert.match(fmtMoney(12.34, { sign: true }), /Rp/);
    assert.match(dailyMoney(12.34, true), /Rp/);
  });
  withDisplayMoney("SOL", rates, () => {
    assert.match(fmtMoney(100, { sign: true }), /SOL/);
  });
  const png = withDisplayMoney("IDR", rates, () =>
    renderSummaryCard({
      kicker: "Daily PnL",
      title: "06 Nov 2026",
      totalUsd: 36.7,
      pnlPct: 2,
      pnlSol: 0.3,
      count: 3,
      wins: 2,
      winRate: 66,
      capitalUsd: 1410,
      feesUsd: 3.6,
      best: { label: "PIRATE", pnlUsd: 42.5 },
      worst: { label: "ZELDA", pnlUsd: -18.2 },
      bars: [
        { label: "PIRATE", pnlUsd: 42.5 },
        { label: "ZELDA", pnlUsd: -18.2 },
        { label: "SLING", pnlUsd: 12.4 },
      ],
      barsLabel: "PnL kumulatif",
      footer: "harian · test",
    }),
  );
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.ok(png.length > 5000);
});

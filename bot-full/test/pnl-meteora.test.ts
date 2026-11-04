import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePnlPosition, fetchPoolPnl } from "../src/engine/meteora-pnl.js";
import { decimalsFromReserve } from "../src/engine/decimals.js";
import { cardDataFromSnapshot } from "../src/telegram/pnl-send.js";
import { compactResult } from "../src/telegram/close-ui.js";
import { binIdToUiPrice } from "../src/engine/dlmm-read.js";
import { fmtCompactUsd, marketCap, mcRangeText } from "../src/engine/supply.js";

// Donkey/SOL zapout as shown in Meteora UI
const donkey = {
  positionAddress: "DonkeyPos111",
  isClosed: true,
  pnlUsd: "0.91",
  pnlPctChange: "1.88",
  pnlSol: "0.0094",
  allTimeDeposits: { total: { usd: "48.56" }, tokenX: { amount: "0", usd: "0" }, tokenY: { amount: "0.5", usd: "48.56" } },
  allTimeWithdrawals: { total: { usd: "48.44" }, tokenX: { amount: "8730", usd: "1.94" }, tokenY: { amount: "0.48", usd: "46.51" } },
  allTimeFees: { total: { usd: "1.03" }, tokenX: { amount: "2510", usd: "0.56" }, tokenY: { amount: "0.0049", usd: "0.48" } },
  unrealizedPnl: null,
};

test("Meteora PnL parse — Donkey case +$0.91 / +1.88%", () => {
  const m = parsePnlPosition(donkey);
  assert.equal(m.pnlUsd, 0.91);
  assert.equal(m.pnlPct, 1.88);
  assert.equal(m.depositUsd, 48.56);
  assert.equal(m.withdrawUsd, 48.44);
  assert.equal(m.feesUsd, 1.03);
  assert.equal(m.feeX.usd, 0.56);
  const card = cardDataFromSnapshot({ pool: "P", position: "DonkeyPos111", pair: "Donkey/SOL", total_value_usd: 46.53, unclaimed_fees_usd: 0.48, cost_usd: 48.59, meteora: m }, true);
  assert.equal(card.pnlUsd, 0.91);
  assert.equal(card.pnlPct, 1.88);
  assert.equal(card.source, "Meteora");
  assert.ok(Math.abs((card.exitUsd ?? 0) - 49.47) < 1e-9);
  const t = compactResult({ kind: "zapout", pair: "Donkey/SOL", success: true, signatures: ["s1"], ms: 2000, solReceived: 0.5509, snapshot: { pool: "P", position: "DonkeyPos111", total_value_usd: null, unclaimed_fees_usd: null, meteora: m } });
  assert.match(t, /\+\$0\.91 \(\+1\.88%\)/);
  assert.match(t, /Realized: \+0\.5509 SOL/);
  assert.match(t, /\+rent, −fee tx & slippage/);
});

test("fallback is labelled estimasi; unknown price → n/a", () => {
  const card = cardDataFromSnapshot({ pool: "P", position: "x", total_value_usd: 50, unclaimed_fees_usd: 1, cost_usd: 48 }, false);
  assert.equal(card.source, "estimasi");
  assert.equal(card.pnlUsd, 3);
  const na = cardDataFromSnapshot({ pool: "P", position: "x", total_value_usd: null, unclaimed_fees_usd: null, cost_usd: 48 }, true);
  assert.equal(na.pnlUsd, null);
  const t = compactResult({ kind: "remove", pair: "X/SOL", success: true, signatures: ["s"], ms: 1000, snapshot: { pool: "P", position: "x", total_value_usd: null, unclaimed_fees_usd: null, cost_usd: 10 } });
  assert.match(t, /PnL: n\/a/);
});

test("open position: unrealized + unclaimed fees", () => {
  const m = parsePnlPosition({
    ...donkey,
    isClosed: false,
    pnlUsd: "-0.5",
    unrealizedPnl: { balances: 40, unclaimedFeeTokenX: { usd: "0.3" }, unclaimedFeeTokenY: { usd: "0.2" } },
  });
  assert.equal(m.balanceUsd, 40);
  assert.equal(m.unclaimedFeesUsd, 0.5);
  const card = cardDataFromSnapshot({ pool: "P", position: "x", total_value_usd: 1, unclaimed_fees_usd: 0, meteora: m }, false);
  assert.equal(card.exitUsd, 40.5);
  assert.equal(card.pnlUsd, -0.5);
});

test("fetchPoolPnl pages + one request per page", async () => {
  let calls = 0;
  const fake = (async (url: string) => {
    calls++;
    assert.match(String(url), /positions\/POOL\/pnl\?user=W&status=open/);
    return { ok: true, json: async () => ({ positions: [donkey], hasNext: false }) };
  }) as unknown as typeof fetch;
  const r = await fetchPoolPnl("POOL", "W", "open", fake);
  assert.equal(calls, 1);
  assert.equal(r.get("DonkeyPos111")?.pnlUsd, 0.91);
});

test("decimals from SDK TokenReserve.mint.decimals (6 vs 9)", () => {
  assert.equal(decimalsFromReserve({ publicKey: "x", mint: { decimals: 6 } }), 6);
  assert.equal(decimalsFromReserve({ mint: { decimals: 9 } }), 9);
  assert.equal(decimalsFromReserve({ decimal: 6 }), null); // old wrong field
  // 6-dec token / 9-dec SOL: price factor 10^(6-9)
  const p6 = binIdToUiPrice(0, 100, 6, 9);
  const p9 = binIdToUiPrice(0, 100, 9, 9);
  assert.ok(Math.abs(p6 / p9 - 1e-3) < 1e-12);
  // amount of 8,730 Donkey (6 dec) atomic
  const atomic = 8730 * 1e6;
  assert.equal(atomic / 10 ** 6, 8730);
  assert.notEqual(atomic / 10 ** 9, 8730); // the old bug: 1000x too small
});

test("market cap range formatting", () => {
  assert.equal(fmtCompactUsd(1_234_567), "$1.23M");
  assert.equal(fmtCompactUsd(950), "$950");
  assert.equal(fmtCompactUsd(12_500), "$12.5K");
  assert.equal(fmtCompactUsd(null), "n/a");
  const sup = 1_000_000_000;
  assert.ok(Math.abs(marketCap(0.000001, 100, sup)! - 100_000) < 1e-6);
  assert.equal(marketCap(0.000001, 100, null), null);
  assert.equal(mcRangeText(marketCap(0.000001, 100, sup), marketCap(0.000002, 100, sup), marketCap(0.0000015, 100, sup)), "MC $100K – $200K (now $150K)");
  assert.equal(mcRangeText(null, null, null), "MC n/a");
});

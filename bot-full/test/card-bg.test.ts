import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { paintCardBackground, preloadPnlBackground, resetBgCache, BUNDLED_PNL_BG, loadBg } from "../src/render/card-bg.js";
import { renderSummaryCard } from "../src/render/daily-card.js";
import { renderPnlCard } from "../src/render/pnl-card.js";
import { createCanvas } from "@napi-rs/canvas";

test("shared background module: both cards read the same loader", async () => {
  const srcDaily = fs.readFileSync(new URL("../src/render/daily-card.ts", import.meta.url), "utf8");
  const srcPos = fs.readFileSync(new URL("../src/render/pnl-card.ts", import.meta.url), "utf8");
  assert.match(srcDaily, /paintCardBackground/);
  assert.match(srcPos, /paintCardBackground/);
  assert.ok(!/bgCache/.test(srcPos));
  assert.match(srcDaily, /chartless|Chartless|bars: SummaryBar\[]/);
  assert.ok(!/monochrome line chart|drawCandles/.test(srcDaily));

  resetBgCache();
  const c = createCanvas(100, 80).getContext("2d");
  paintCardBackground(c, 100, 80, {});
  // no throw without bg
  const png = renderSummaryCard({
    kicker: "Daily PnL", title: "06 Nov 2026", totalUsd: 12.5, pnlPct: 2.1, pnlSol: 0.1,
    count: 3, wins: 2, winRate: 66.7, capitalUsd: 500, feesUsd: 4, best: { label: "RAM", pnlUsd: 10 },
    worst: { label: "WIF", pnlUsd: -2 }, bars: [], footer: "harian · 06 Nov 2026 13:00 KST",
  });
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.ok(png.length > 3000);
});

test("changing one background path feeds every card type", async () => {
  // use a tiny generated jpeg via canvas if no bundled bg
  const { createCanvas: cc } = await import("@napi-rs/canvas");
  const tmp = path.join(fs.mkdtempSync("/tmp/bg-"), "pnl-bg.jpg");
  const cv = cc(64, 64);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#112233";
  ctx.fillRect(0, 0, 64, 64);
  fs.writeFileSync(tmp, cv.toBuffer("image/jpeg"));
  resetBgCache();
  await preloadPnlBackground(tmp);
  assert.ok(loadBg(tmp));
  const daily = renderSummaryCard({
    kicker: "Weekly PnL", title: "Sen–Min", totalUsd: -3, pnlPct: -1, pnlSol: null,
    count: 1, wins: 0, winRate: 0, capitalUsd: 100, feesUsd: 1, bars: [], footer: "mingguan",
    background: tmp, bgDarkPct: 50,
  });
  const pos = renderPnlCard({
    pair: "A/SOL", position: "P", closed: true, depositUsd: 1, exitUsd: 1, feesUsd: 0,
    pnlUsd: 0, pnlPct: 0, duration: "1m", minPrice: null, maxPrice: null, timeLabel: "x",
    background: tmp, bgDarkPct: 50,
  } as never);
  assert.equal(daily.subarray(1, 4).toString(), "PNG");
  assert.equal(pos.subarray(1, 4).toString(), "PNG");
});

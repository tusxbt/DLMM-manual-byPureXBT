import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.DATA_DIR = fs.mkdtempSync("/tmp/hist-");
const H = await import("../src/store/history.js");
const UI = await import("../src/telegram/history-ui.js");

const rec = (i: number, pnl: number | null, closed: string, token = "MINTA", pair = "PIRATE/SOL") => ({
  position: `Pos${String(i).padStart(40, "1")}`, pool: "Pool1", pair, token, closed_at: closed, kind: "zapout" as const,
  capital_usd: 100, exit_usd: pnl == null ? null : 100 + pnl, fees_usd: 1, pnl_usd: pnl, pnl_pct: pnl, source: "realized" as const,
});

test("KST day boundary", () => {
  assert.equal(H.kstDay("2026-11-04T14:59:00Z"), "2026-11-04");
  assert.equal(H.kstDay("2026-11-04T15:00:00Z"), "2026-11-05"); // 00:00 KST
});

test("store: add replaces same position, newest first; import never duplicates", () => {
  H.addHistory(rec(1, 5, "2026-11-04T01:00:00Z"));
  H.addHistory(rec(2, -2, "2026-11-05T01:00:00Z"));
  H.addHistory(rec(1, 6, "2026-11-04T01:00:00Z"));
  const l = H.loadHistory();
  assert.equal(l.length, 2);
  assert.equal(l[0].pnl_usd, -2);
  assert.equal(l[1].pnl_usd, 6);
  assert.equal(H.mergeImported([rec(1, 99, "2026-11-01T00:00:00Z"), rec(3, 1, "2026-11-01T00:00:00Z")]), 1);
  assert.equal(H.loadHistory().find((r) => r.position === rec(1, 0, "").position)!.pnl_usd, 6);
});

test("aggregates: per token (count, win rate), per day incl. empty days", () => {
  const list = [rec(1, 5, "2026-11-04T01:00:00Z"), rec(2, -2, "2026-11-05T01:00:00Z"), rec(3, 3, "2026-11-05T02:00:00Z", "MINTB", "RAM/SOL"), rec(4, null, "2026-11-05T03:00:00Z")];
  const t = H.byToken(list);
  const a = t.find((x) => x.key === "MINTA")!;
  assert.equal(a.count, 3); assert.equal(a.wins, 1); assert.equal(a.unknown, 1); assert.equal(a.pnlUsd, 3);
  assert.equal(H.winRate(a), 50);
  assert.equal(a.label, "PIRATE");
  const d = H.byDay(list, 7, new Date("2026-11-05T10:00:00Z"));
  assert.equal(d.length, 7);
  assert.equal(d[6].key, "2026-11-05"); assert.equal(d[6].count, 3); assert.equal(d[6].pnlUsd, 1);
  assert.equal(d[5].pnlUsd, 5); assert.equal(d[0].count, 0);
});

test("record from snapshot uses on-chain realized first; UI pages + callbacks fit 64 bytes", () => {
  const snap = { pair: "PIRATE-SOL", pool: "Pool1", position: rec(9, 0, "").position, mint_x: "MINTA", total_value_usd: 90, unclaimed_fees_usd: 1, cost_usd: 100, strategy: "Spot",
    realized: { solNet: 1, tokenNet: {}, rentSol: 0, feeSol: 0, exitUsd: 104, pnlUsd: 4, pnlPct: 4, pnlSol: 0.02, depositSol: 0.5 } };
  const r = UI.recordFromSnapshot(snap as never, "zapout", new Date("2026-11-05T03:00:00Z"));
  assert.equal(r.pnl_usd, 4); assert.equal(r.source, "realized"); assert.equal(r.pair, "PIRATE/SOL"); assert.equal(r.token, "MINTA"); assert.equal(r.pnl_sol, 0.02);
  const list = Array.from({ length: 11 }, (_, i) => rec(i + 1, i - 5, `2026-11-0${(i % 5) + 1}T01:00:00Z`));
  const views = [UI.historyHome(list, new Date("2026-11-05T10:00:00Z")), UI.positionsPage(list, 0), UI.positionsPage(list, 1), UI.tokensPage(list, 0), UI.tokenSummary(list, "MINTA"), UI.daysPage(list, 7, new Date("2026-11-05T10:00:00Z")), UI.daysPage(list, 30)];
  for (const v of views) for (const b of v.kb.inline_keyboard.flat()) assert.ok(Buffer.byteLength((b as { callback_data: string }).callback_data) <= 64, (b as { callback_data: string }).callback_data);
  const p0 = JSON.stringify(UI.positionsPage(list, 0).kb.inline_keyboard);
  assert.ok(p0.includes("hi:pc:") && p0.includes("hi:pos:1") && p0.includes("hi:menu"));
  assert.match(UI.historyHome(list, new Date("2026-11-05T10:00:00Z")).text, /Riwayat PnL/);
  const dc = UI.dailyCardData(list, 7, new Date("2026-11-05T10:00:00Z"));
  assert.equal(dc.days.length, 7); assert.ok(dc.best && dc.worst);
});

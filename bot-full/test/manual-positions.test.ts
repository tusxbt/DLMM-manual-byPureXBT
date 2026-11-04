import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCards, renderPositionCard } from "../src/telegram/positions-view.js";
import { parseTime, parsePnlPosition } from "../src/engine/meteora-pnl.js";

const live = (position: string) =>
  ({ pool: "Pool1", position, total_value_usd: 50, unclaimed_fees_usd: 1, in_range: true, min_bin: 0, max_bin: 68 }) as never;

test("on-chain positions merged with bot metadata; manual (meteora.ag) ones kept + marked; deduped", () => {
  const tracked = [{ position: "BOT1", pool: "Pool1", strategy: "bid_ask", strategy_label: "Mix 70/30", opened_at: "2026-11-04T00:00:00Z", cost_usd: 48 }];
  const met = new Map([["MAN1", { ...parsePnlPosition({ positionAddress: "MAN1", pnlUsd: "2.5", pnlPctChange: "5", createdAt: 1793000000 }) }]]);
  const out = mergeCards([live("BOT1"), live("MAN1"), live("MAN1")], tracked as never, met);
  assert.equal(out.length, 2);
  const bot = out.find((c) => c.position === "BOT1")!;
  const man = out.find((c) => c.position === "MAN1")!;
  assert.equal(bot.manual, false);
  assert.equal(bot.strategy_text, "Mix 70/30");
  assert.equal(man.manual, true);
  assert.equal(man.strategy_text, undefined);
  assert.equal(man.meteora?.pnlUsd, 2.5);
  assert.equal(man.opened_at, new Date(1793000000 * 1000).toISOString());
  const card = renderPositionCard({ ...man, pair: "A/SOL" } as never);
  assert.match(card, /\[manual · 69 bins\]/);
  assert.match(card, /\+\$2\.50/);
});

test("parseTime: seconds, ms, ISO; junk → null", () => {
  assert.equal(parseTime(1793000000), "2026-10-26T07:33:20.000Z");
  assert.equal(parseTime(1793000000000), "2026-10-26T07:33:20.000Z");
  assert.equal(parseTime("2026-11-04T00:00:00Z"), "2026-11-04T00:00:00.000Z");
  assert.equal(parseTime("x"), null);
  assert.equal(parseTime(null), null);
});

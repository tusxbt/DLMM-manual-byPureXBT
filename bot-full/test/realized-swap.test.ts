import { test } from "node:test";
import assert from "node:assert/strict";
import { realizedFromFlows, realizedSol, type TxFlow } from "../src/engine/realized.js";
import { compactResult } from "../src/telegram/close-ui.js";
import { cardDataFromSnapshot } from "../src/telegram/pnl-send.js";

const W = "Wa11et1111111111111111111111111111111111111";
const D = "DAViD11111111111111111111111111111111111111";
const L = 1e9;
// close tx: +0.967 SOL withdrawn +0.081 SOL fee, position rent 0.057 refunded, +414,496 DAVID; swap tx: −414,496 DAVID → +3.5231 SOL
const close: TxFlow = {
  keys: [W, "Pos1"], feePayer: W, fee: 5000,
  pre: [1 * L, 0.057 * L], post: [1 * L + (0.967 + 0.081 + 0.057) * L - 5000, 0],
  preTok: [{ i: 5, mint: D, owner: W, amount: "0", decimals: 6 }],
  postTok: [{ i: 5, mint: D, owner: W, amount: String(414_496 * 1e6), decimals: 6 }],
};
const swap: TxFlow = {
  keys: [W], feePayer: W, fee: 5000,
  pre: [3 * L], post: [3 * L + 3.5231 * L - 5000],
  preTok: [{ i: 5, mint: D, owner: W, amount: String(414_496 * 1e6), decimals: 6 }],
  postTok: [{ i: 5, mint: D, owner: W, amount: "0", decimals: 6 }],
};

test("zapout realized = close + swap flows in SOL (swap loss included, rent excluded)", () => {
  const r = realizedFromFlows([close, swap], W);
  assert.ok(Math.abs(r.solNet - 4.5711) < 1e-6, String(r.solNet));
  assert.deepEqual(r.tokenNet, {});
  const x = realizedSol(r, 100, {}, 5);
  assert.ok(Math.abs(x.pnlSol! + 0.4289) < 1e-6);
  assert.ok(Math.abs(x.pnlPct! + 8.578) < 1e-3);
});

test("result + PnL card prefer on-chain realized over Meteora (-7.06%)", () => {
  const r = realizedFromFlows([close, swap], W);
  const realized = { ...r, ...realizedSol(r, 100, {}, 5) };
  const meteora = { position: "P", closed: true, pnlUsd: -35.3, pnlPct: -7.06, pnlSol: -0.353, depositUsd: 500, withdrawUsd: 456, feesUsd: 8, feeX: { amount: null, usd: null }, feeY: { amount: null, usd: null }, balanceUsd: null, unclaimedFeesUsd: null };
  const snap = { pool: "Pool", position: "P", pair: "DAVID/SOL", amount_sol: 5, meteora, realized } as never;
  const txt = compactResult({ kind: "zapout", pair: "DAVID/SOL", success: true, signatures: ["a", "b"], ms: 1000, realized, snapshot: snap } as never);
  assert.match(txt, /PnL SOL: −0\.4289/);
  assert.match(txt, /−8\.58%/);
  assert.match(txt, /Meteora: .*−7\.06%/);
  const card = cardDataFromSnapshot(snap, true);
  assert.equal(card.source, "realized");
  assert.ok(Math.abs(card.pnlPct! + 8.578) < 1e-3);
});

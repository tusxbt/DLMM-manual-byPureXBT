import { test } from "node:test";
import assert from "node:assert/strict";
import { realizedFromFlows, realizedSol, lifecycleRealized, type TxFlow } from "../src/engine/realized.js";

// Real case SLINGTOSHI/SOL 4kuco…prg1 (Mix 70/30, 5 SOL, 2× Flip): lamports from mainnet txs.
const W = "Wallet";
const TOK = "F1LQvmTok";
const L = 1e9;
const tok = (amt: number, before: number) => ({
  preTok: [{ i: 1, mint: TOK, owner: W, amount: String(before), decimals: 6 }],
  postTok: [{ i: 1, mint: TOK, owner: W, amount: String(before + amt), decimals: 6 }],
});
const flow = (solLamports: number, opts: Partial<TxFlow> & { tokAmt?: number; rentNew?: number; rentClosed?: number } = {}): TxFlow => {
  const keys = [W, "Ata", "PosAcct"];
  const fee = 10_000;
  const rentNew = opts.rentNew ?? 0, rentClosed = opts.rentClosed ?? 0;
  return {
    keys,
    pre: [10 * L, 2_039_280, rentClosed],
    post: [10 * L + solLamports - fee - rentNew + rentClosed, 2_039_280, rentNew],
    fee,
    feePayer: W,
    ...(opts.tokAmt ? tok(opts.tokAmt, 1_000_000) : { preTok: [], postTok: [] }),
    opensPosition: opts.opensPosition,
  };
};
const T = 179_976_198_400; // 179,976.1984 token (6 dec)
const flows: TxFlow[] = [
  flow(-3_500_000_000, { opensPosition: true, rentNew: 41_900_000 }), // open (spot stage)
  flow(-1_500_000_000), // Mix stage 2
  flow(184_461_000, { tokAmt: T }), // Flip #1 withdraw: token AND 0.1845 SOL back to wallet
  flow(0, { tokAmt: -T }), // Flip #1 re-add (token only)
  flow(0, { tokAmt: T }), // Flip #2 withdraw
  flow(0, { tokAmt: -T }), // Flip #2 re-add
  flow(3_422_037_000, { tokAmt: T, rentClosed: 41_900_000 }), // claim+remove+close
  flow(1_313_768_000, { tokAmt: -T }), // swap token → SOL
];

test("old close+swap-only realized misses the SOL returned by Flip withdraw", () => {
  const old = realizedFromFlows(flows.slice(6), W);
  const o = realizedSol(old, 96.1, {}, 5);
  assert.ok(Math.abs((o.pnlSol as number) - -0.264195) < 1e-6, String(o.pnlSol)); // the wrong -0.2642
});

test("lifecycle realized: open + flips + close + swap → true PnL", () => {
  const life = lifecycleRealized(flows, W, 5)!;
  assert.ok(life);
  assert.ok(Math.abs(life.lifecycleSol - -0.079734) < 1e-6, String(life.lifecycleSol));
  assert.equal(Object.keys(life.tokenNet).length, 0); // flips/swap net out the token
  const r = realizedSol(life, 96.1, {}, life.depositSol);
  assert.ok(Math.abs((r.pnlSol as number) - -0.079734) < 1e-6);
  assert.ok(Math.abs((r.exitSol as number) - 4.920266) < 1e-6);
  assert.ok(Math.abs((r.pnlPct as number) - -1.5947) < 1e-3);
  assert.ok(Math.abs(life.rentSol) < 1e-12); // position rent paid at open and refunded at close
  // no tracked amount → deposit = SOL outflows
  const auto = lifecycleRealized(flows, W, null)!;
  assert.ok(Math.abs(auto.depositSol - 5) < 1e-9);
  // open tx missing from history → no lifecycle (caller falls back)
  assert.equal(lifecycleRealized(flows.slice(1), W, 5), null);
});

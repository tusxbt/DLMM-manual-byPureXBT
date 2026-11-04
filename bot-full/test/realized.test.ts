import { test } from "node:test";
import assert from "node:assert/strict";
import { realizedFromFlows, realizedUsd, type TxFlow } from "../src/engine/realized.js";

const W = "Wallet1111";
const SOL = "So11111111111111111111111111111111111111112";
const TOK = "TokenMint111";

test("exit: rent refund (position close) and tx fee excluded; token withdrawn counted", () => {
  // keys: wallet, position (closed, rent 0.0574), tokenATA (wallet-owned)
  const f: TxFlow = {
    keys: [W, "Position1", "Ata1"],
    pre: [1_000_000_000, 57_400_000, 2_039_280],
    post: [1_000_000_000 + 500_000_000 + 57_400_000 - 5_000, 0, 2_039_280],
    fee: 5_000,
    feePayer: W,
    preTok: [{ i: 2, mint: TOK, owner: W, amount: "0", decimals: 6 }],
    postTok: [{ i: 2, mint: TOK, owner: W, amount: "1500000", decimals: 6 }],
  };
  const r = realizedFromFlows([f], W);
  assert.ok(Math.abs(r.solNet - 0.5) < 1e-12, String(r.solNet)); // withdrawn SOL only
  assert.ok(Math.abs(r.rentSol - 0.0574) < 1e-12);
  assert.equal(r.feeSol, 0.000005);
  assert.equal(r.tokenNet[TOK], 1.5);
  const u = realizedUsd(r, 100, { [TOK]: 2 }, 50);
  assert.equal(u.exitUsd, 53); // 0.5*100 + 1.5*2
  assert.equal(u.pnlUsd, 3);
  assert.equal(u.pnlPct, 6);
});

test("zapout: wSOL ATA closed (rent refund excluded, wrapped SOL counted); new ATA rent paid excluded", () => {
  const f: TxFlow = {
    keys: [W, "WsolAta", "NewAta"],
    // WsolAta held 0.2 wSOL + 0.00203928 rent, closed → wallet gets both
    pre: [1_000_000_000, 202_039_280, 0],
    post: [1_000_000_000 + 202_039_280 - 2_039_280 - 5_000, 0, 2_039_280],
    fee: 5_000,
    feePayer: W,
    preTok: [{ i: 1, mint: SOL, owner: W, amount: "200000000", decimals: 9 }],
    postTok: [{ i: 2, mint: TOK, owner: W, amount: "0", decimals: 6 }],
  };
  const r = realizedFromFlows([f], W);
  // wallet +0.2 SOL... minus wrapped already owned (pre) → 0 received in this tx (it was already wallet value)
  assert.ok(Math.abs(r.solNet - 0) < 1e-12, String(r.solNet));
  assert.ok(Math.abs(r.rentSol - 0) < 1e-12, String(r.rentSol)); // +0.00203928 refund − 0.00203928 paid
});

test("unknown token price → no guess; no deposit → pnl null", () => {
  const r = { solNet: 1, tokenNet: { X: 5 }, rentSol: 0, feeSol: 0 };
  assert.equal(realizedUsd(r, 100, {}, 50).pnlUsd, null);
  assert.equal(realizedUsd({ ...r, tokenNet: {} }, 100, {}, null).exitUsd, 100);
  assert.equal(realizedUsd({ ...r, tokenNet: {} }, 100, {}, null).pnlUsd, null);
});

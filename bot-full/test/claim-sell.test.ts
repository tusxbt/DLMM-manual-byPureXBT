import { test } from "node:test";
import assert from "node:assert/strict";
import { claimMenu, renderClaimSellPreview } from "../src/telegram/positions-view.js";
import { expiredAction } from "../src/engine/confirm.js";
const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const q = { pool: A, position: A, tokenMint: A, tokenDecimals: 6, feeTokenAtomic: "1500000", feeTokenUi: 1.5, feeSolUi: 0.002, tokenUsd: 3, estSolOut: 0.02, capUsd: 100, overCap: false };
test("claim menu: Keep / Sell / Kembali", () => {
  const k = JSON.stringify(claimMenu({ position: A }).kb);
  for (const c of [`pv:ck:${A}`, `pv:cs:${A}`, `pv:open:${A}`]) assert.ok(k.includes(c), c);
});
test("sell preview shows fees + est SOL; blocks on 0 token or over MAX_SWAP_USD", () => {
  const ok = renderClaimSellPreview(q, "X/SOL");
  assert.ok(!ok.blocked);
  assert.match(ok.text, /≈0\.020000 SOL/);
  assert.match(ok.text, /delta token hasil claim/);
  assert.ok(renderClaimSellPreview({ ...q, feeTokenUi: 0, feeTokenAtomic: "0" }).blocked);
  assert.ok(renderClaimSellPreview({ ...q, overCap: true, tokenUsd: 500 }).blocked);
  assert.deepEqual(expiredAction({ purpose: "claimsell", payload: { position: A } }), { kind: "claimsell", position: A });
});

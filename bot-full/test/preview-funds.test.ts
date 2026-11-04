import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAddPreview, binArrayWarning } from "../src/telegram/preview.js";
import { checkFunds } from "../src/engine/funds-check.js";

const base = {
  pool: "Impeach/SOL", side: "SOL side", strategy: "Bid-Ask", amount: "1 SOL", bins: 40, below: 40, above: 0,
  downPct: 54.7, upPct: 0, minPrice: 0.00000151, maxPrice: 0.00000334, solUsd: 96.93, mcMin: 139000, mcMax: 307000, mcNow: 307000,
  costUsd: 96.93, capUsd: 500, slippagePct: 10, position: "Pos111", dryRun: false, ttlSec: 60,
};

test("compact preview ≤ 10 lines, no bin-array warning when 0", () => {
  const t = renderAddPreview({ ...base, rent: { positionRentSol: 0.057, binArrayRentSol: 0, binArraysCount: 0 } });
  assert.ok(t.split("\n").length <= 10, t);
  assert.match(t, /👀 \*\*Impeach\/SOL\*\* · ⚠️ LIVE/);
  assert.match(t, /💵 1 SOL \(\$96\.93\) · Bid-Ask · SOL side/);
  assert.match(t, /40 bins \(−54\.7%\)/);
  assert.match(t, /🏷 MC \$139K–\$307K \(now \$307K\)/);
  assert.match(t, /🧾 1 tx · rent ≈0\.057 SOL \(kembali\) · slip 10%/);
  assert.doesNotMatch(t, /Bin array|cap|Pos111/);
});

test("bin array warning + funds block", () => {
  const rent = { positionRentSol: 0.057, binArrayRentSol: 0.14, binArraysCount: 2 };
  assert.match(binArrayWarning(rent)!, /Bin array baru: 2 × ≈0\.07 SOL \(tidak kembali\)/);
  const funds = checkFunds({ haveSol: 1, amountSol: 1, positionRentSol: 0.057, binArrayRentSol: 0.14, txCount: 1 });
  assert.equal(funds.ok, false);
  assert.ok(Math.abs(funds.needSol - (1 + 0.057 + 0.14 + 0.012)) < 1e-9);
  const t = renderAddPreview({ ...base, rent, funds });
  assert.match(t, /Bin array baru/);
  assert.match(t, /Saldo SOL kurang/);
  assert.ok(checkFunds({ haveSol: 2, amountSol: 1, positionRentSol: 0.057, binArrayRentSol: 0.14 }).ok);
});

test("cap line only near cap", () => {
  assert.match(renderAddPreview({ ...base, costUsd: 450 }), /cap \$500/);
});

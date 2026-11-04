import test from "node:test";
import assert from "node:assert/strict";
import { fmtUsd, shortAddr } from "../src/format.js";
import { binsFromPct } from "../src/engine/dlmm-build.js";
import { normalizeMint } from "../src/engine/jupiter-swap.js";
import { SOL_MINT } from "../src/config.js";

test("fmtUsd and shortAddr", () => {
  assert.equal(fmtUsd(12.5), "$12.50");
  assert.equal(fmtUsd(-1.2), "-$1.20");
  assert.ok(shortAddr("So11111111111111111111111111111111111111112").includes("…"));
});

test("normalizeMint", () => {
  assert.equal(normalizeMint("SOL"), SOL_MINT);
  assert.equal(normalizeMint("native"), SOL_MINT);
});

test("binsFromPct increases with wider pct", () => {
  const a = binsFromPct(1, 10, 100, "down");
  const b = binsFromPct(1, 40, 100, "down");
  assert.ok(b > a);
  assert.equal(binsFromPct(1, 0, 100, "down"), 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.DATA_DIR ||= fs.mkdtempSync("/tmp/ds-");
const { dynamicSlippageParam } = await import("../src/engine/jupiter-swap.js");
test("dynamic slippage cap: from setting, clamped 10–5000 bps", () => {
  assert.deepEqual(dynamicSlippageParam(1000), { maxBps: 1000 });
  assert.deepEqual(dynamicSlippageParam(1), { maxBps: 10 });
  assert.deepEqual(dynamicSlippageParam(99999), { maxBps: 5000 });
  assert.ok(dynamicSlippageParam().maxBps >= 10);
  const src = fs.readFileSync(new URL("../src/engine/jupiter-swap.ts", import.meta.url), "utf8");
  assert.match(src, /dynamicSlippage: dynamicSlippageParam/);
});

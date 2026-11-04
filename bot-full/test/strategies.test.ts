import test from "node:test";
import assert from "node:assert/strict";
import { listStrategies, getStrategy, requireStrategy } from "../src/strategies/index.js";

test("registry includes Spot Curve BidAsk", () => {
  const ids = listStrategies().map((s) => s.id).sort();
  assert.deepEqual(ids, ["bid_ask", "curve", "spot"]);
  assert.equal(getStrategy("spot")?.meteoraKey, "Spot");
  assert.equal(requireStrategy("curve").label, "Curve");
  assert.throws(() => requireStrategy("nope"));
});

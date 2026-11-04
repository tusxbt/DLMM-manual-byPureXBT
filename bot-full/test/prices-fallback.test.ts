import { test } from "node:test";
import assert from "node:assert/strict";
import { getUsdPrices, resetPriceStateForTests, backoffMs, priceSourceOf } from "../src/engine/prices.js";

const J = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const S = "So11111111111111111111111111111111111111112";
const resp = (status: number, body: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: h });

test("backoff respects Retry-After, else exponential", () => {
  assert.equal(backoffMs(0, "2"), 2000);
  assert.equal(backoffMs(0, null), 500);
  assert.equal(backoffMs(2, null), 2000);
});
test("429 with long Retry-After → Meteora/DexScreener fallback, batched, cached + shared", async () => {
  const calls: string[] = [];
  resetPriceStateForTests((async (u: string) => {
    calls.push(String(u));
    if (String(u).includes("jup.ag")) return resp(429, {}, { "retry-after": "30" });
    if (String(u).includes("meteora")) return resp(200, { data: [{ token_x: { address: J, price: 0.26 }, token_y: { address: S, price: 96 } }] });
    return resp(200, [{ baseToken: { address: S }, priceUsd: "95", liquidity: { usd: 1e6 } }]);
  }) as never);
  const [a, b] = await Promise.all([getUsdPrices([J, S]), getUsdPrices([S, J])]);
  assert.equal(a[J], 0.26);
  assert.ok(a[S] > 0);
  assert.deepEqual(a, b);
  assert.equal(priceSourceOf(J), "meteora");
  const n = calls.length;
  await getUsdPrices([J]);
  assert.equal(calls.length, n, "served from cache");
  assert.equal(calls.filter((c) => c.includes("jup.ag")).length, 1, "one batched Jupiter request, then cooldown");
});
test("Jupiter OK → used directly", async () => {
  resetPriceStateForTests((async () => resp(200, { [J]: { usdPrice: 0.3 } })) as never);
  assert.equal((await getUsdPrices([J]))[J], 0.3);
  assert.equal(priceSourceOf(J), "jupiter");
  resetPriceStateForTests();
});

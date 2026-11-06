import test from "node:test";
import assert from "node:assert/strict";
import { parseRpcUrls, isValidRpcUrl, RpcFailover } from "../src/engine/rpc-failover.js";

test("parseRpcUrls rejects undefined/null/empty slots", () => {
  assert.deepEqual(parseRpcUrls("undefined,null,", null).length >= 1, true);
  assert.ok(parseRpcUrls(undefined, undefined)[0]!.startsWith("https://"));
  assert.ok(isValidRpcUrl("https://api.mainnet-beta.solana.com"));
  assert.equal(isValidRpcUrl("undefined"), false);
  assert.equal(isValidRpcUrl(undefined), false);
  assert.equal(isValidRpcUrl(""), false);
  const u = parseRpcUrls("https://a.example/rpc,undefined,https://b.example/rpc", null);
  assert.equal(u.length, 2);
});

test("RpcFailover never fetch(undefined) on bad input", async () => {
  const calls: string[] = [];
  const f = new RpcFailover(["https://rpc.example/ok"], {
    fetchFn: async (input) => {
      const s = String(input);
      calls.push(s);
      if (s === "undefined" || input == null) throw new TypeError("Failed to parse URL from undefined");
      return new Response("{}", { status: 200 });
    },
  });
  await f.fetch(undefined as never);
  await f.fetch(null as never);
  await f.fetch({ url: undefined } as never);
  assert.ok(calls.every((c) => c.startsWith("https://rpc.example")));
});

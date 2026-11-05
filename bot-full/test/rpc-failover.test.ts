import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.DATA_DIR ||= fs.mkdtempSync("/tmp/rpcf-");
process.env.RPC_URL = "https://rpc-a.example/api?api-key=SECRET_A";
delete process.env.RPC_URLS;

const {
  parseRpcUrls,
  rpcLabel,
  isFailoverHttpStatus,
  isFailoverErrorMessage,
  RpcFailover,
  RPC_COOLDOWN_MS,
} = await import("../src/engine/rpc-failover.js");

test("parseRpcUrls: RPC_URLS wins; empty → RPC_URL; dedupe; default", () => {
  assert.deepEqual(parseRpcUrls("https://a, https://b ,https://a", "https://c"), ["https://a", "https://b"]);
  assert.deepEqual(parseRpcUrls("", "https://only"), ["https://only"]);
  assert.deepEqual(parseRpcUrls(null, null), ["https://api.mainnet-beta.solana.com"]);
  assert.deepEqual(parseRpcUrls("  ,  ", ""), ["https://api.mainnet-beta.solana.com"]);
});

test("labels never embed URL or key", () => {
  assert.equal(rpcLabel(0), "rpc#1");
  assert.equal(rpcLabel(2), "rpc#3");
  assert.ok(isFailoverHttpStatus(429) && isFailoverHttpStatus(503) && !isFailoverHttpStatus(400));
  assert.ok(isFailoverErrorMessage("fetch failed") && isFailoverErrorMessage("HTTP 429 Too Many Requests"));
  assert.ok(!isFailoverErrorMessage("blockhash not found"));
});

test("failover fetch: 429 on rpc#1 → rpc#2 success; cools down #1; rewrite keeps api-key of target", async () => {
  const urls = ["https://rpc-a.example/?api-key=SECRET_A", "https://rpc-b.example/?api-key=SECRET_B"];
  const hits: string[] = [];
  let now = 1_000_000;
  const switches: string[] = [];
  const fa = new RpcFailover(urls, {
    cooldownMs: 45_000,
    now: () => now,
    onSwitch: (f, t, r) => switches.push(`${f}->${t}:${r}`),
    fetchFn: async (input) => {
      const u = String(input);
      hits.push(u);
      assert.ok(!u.includes("SECRET_A") || u.includes("rpc-a"), "first hit");
      if (u.includes("rpc-a")) return new Response("rate", { status: 429 });
      assert.ok(u.includes("SECRET_B") && u.includes("rpc-b"));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  // Connection would call the primary URL; we rewrite
  const res = await fa.fetch("https://rpc-a.example/?api-key=SECRET_A", {
    method: "POST",
    body: "{}",
  });
  assert.equal(res.status, 200);
  assert.equal(fa.index, 1);
  assert.equal(hits.length, 2);
  assert.ok(switches.some((s) => s.startsWith("0->1")));
  // #1 still cooling → stay on #2
  const res2 = await fa.fetch("https://rpc-a.example/?api-key=SECRET_A");
  assert.equal(res2.status, 200);
  assert.equal(hits.length, 3);
  assert.ok(hits[2]!.includes("rpc-b"));
  // after cooldown, #1 usable again but we stay until it fails
  now += RPC_COOLDOWN_MS + 1;
  assert.equal(fa.pick(0), 0);
});

test("all RPCs 503 → throws; timeout-like error also fails over", async () => {
  const urls = ["https://a.example", "https://b.example"];
  let n = 0;
  const fa = new RpcFailover(urls, {
    cooldownMs: 1000,
    fetchFn: async () => {
      n++;
      return new Response("no", { status: 503 });
    },
  });
  await assert.rejects(() => fa.fetch("https://a.example"), /503/);
  assert.equal(n, 2);

  n = 0;
  const fa2 = new RpcFailover(urls, {
    cooldownMs: 1000,
    fetchFn: async (input) => {
      n++;
      if (String(input).includes("a.example")) throw new Error("fetch failed");
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal((await fa2.fetch("https://a.example")).status, 200);
  assert.equal(n, 2);
  assert.equal(fa2.index, 1);
});

test("config loads rpcUrls from RPC_URLS; connection fetch fails over", async () => {
  process.env.RPC_URLS = "https://x.example/?api-key=AAA,https://y.example/?api-key=BBB";
  process.env.RPC_URL = "https://ignored.example/?api-key=CCC";
  const { resetConfigForTests, loadConfig } = await import("../src/config.js");
  resetConfigForTests();
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  assert.equal(cfg.rpcUrls.length, 2);
  assert.equal(cfg.rpcUrl, cfg.rpcUrls[0]);
  assert.ok(cfg.rpcUrl.includes("x.example"));
  assert.ok(!JSON.stringify({ u: cfg.rpcUrls.map((u, i) => `rpc#${i + 1}`) }).includes("AAA"));

  const { resetConnection, getConnection, getRpcFailover } = await import("../src/engine/connection.js");
  resetConnection();
  // empty RPC_URLS → fall back to RPC_URL
  delete process.env.RPC_URLS;
  process.env.RPC_URL = "https://only.example/?api-key=ONLY";
  resetConfigForTests();
  resetConnection();
  const cfg2 = loadConfig({ requireTelegram: false, skipWallet: true });
  assert.deepEqual(cfg2.rpcUrls, ["https://only.example/?api-key=ONLY"]);
  getConnection();
  assert.equal(getRpcFailover()?.size, 1);
  resetConnection();
});

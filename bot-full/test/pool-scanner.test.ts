import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runScan, rank, scanConfig, riskFlags, mapPool, scorePool, readLatest, SOL } from "../src/scan/scanner.js";
import { scanText } from "../src/scan/format.js";
import { scanHandler, authOk, startScanHttp } from "../src/scan/http.js";

const now = Date.now();
const pool = (o: Record<string, unknown>) => ({
  address: "A", token_x: { address: "TOK", symbol: "TOK", is_verified: true, holders: 5000, freeze_authority_disabled: true }, token_y: { address: SOL, symbol: "SOL" },
  tvl: 200_000, volume: { "24h": 1_000_000 }, fees: { "24h": 5_000 }, fee_tvl_ratio: { "24h": 2.5 }, pool_config: { bin_step: 80, base_fee_pct: 0.8 }, created_at: now - 30 * 86400e3, is_blacklisted: false, ...o,
});
const rows = [
  pool({ address: "GOOD" }),
  pool({ address: "SMALL", tvl: 15_000, fee_tvl_ratio: { "24h": 20 }, fees: { "24h": 3000 }, volume: { "24h": 60_000 } }),
  pool({ address: "NEW", created_at: now - 3600e3, token_x: { address: "N", symbol: "NEW", freeze_authority_disabled: false, is_verified: false, holders: 120 } }),
  pool({ address: "NOSOL", token_y: { address: "USDC", symbol: "USDC" } }),
  pool({ address: "WIDE", pool_config: { bin_step: 400, base_fee_pct: 2 } }),
  pool({ address: "DEAD", volume: { "24h": 100 } }),
  pool({ address: "BL", is_blacklisted: true }),
];
const mockFetch = (async () => new Response(JSON.stringify({ data: rows }), { status: 200 })) as typeof fetch;

test("config defaults + env override", () => {
  const c = scanConfig({});
  assert.deepEqual([c.minTvl, c.minVol24h, c.maxBinStep, c.topN], [10_000, 25_000, 200, 15]);
  assert.equal(scanConfig({ SCAN_MIN_TVL: "50000", SCAN_TOP_N: "99" }).topN, 50);
  assert.equal(scanConfig({ SCAN_MIN_TVL: "50000" }).minTvl, 50_000);
});
test("rank: SOL pairs only, filters, score order, explained flags", () => {
  const r = rank(rows, scanConfig({}), now);
  assert.deepEqual(r.pools.map((p) => p.address).sort(), ["GOOD", "NEW", "SMALL"]);
  assert.equal(r.pools[0].address, "GOOD");
  const flags = (a: string) => r.pools.find((p) => p.address === a)!.flags.map((f) => f.code);
  assert.deepEqual(flags("GOOD"), []);
  assert.ok(flags("SMALL").includes("LOW_TVL") && flags("SMALL").includes("APR_VS_TVL"));
  for (const c of ["NEW_POOL", "FREEZE_AUTH", "UNVERIFIED", "FEW_HOLDERS"]) assert.ok(flags("NEW").includes(c), c);
  assert.ok(r.pools.every((p) => p.flags.every((f) => f.why.length > 10)));
  assert.equal(r.pools[0].feeApr, 2.5 * 365);
});
test("LOW_FEE_VOL flag + score bounds", () => {
  const m = mapPool(pool({ fees: { "24h": 100 } }), now)!;
  assert.ok(riskFlags(m, scanConfig({})).some((f) => f.code === "LOW_FEE_VOL"));
  assert.ok(scorePool({ feeApr: 1e6, fees24h: 1e9, vol24h: 1e9, tvl: 1e9 }, 0) === 100);
  assert.equal(scorePool({ feeApr: 0, fees24h: 0, vol24h: 0, tvl: 0 }, 3), 0);
});
test("runScan writes compact latest.json; /scan text is Indonesian, USD, no buttons", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  const r = await runScan({ fetchFn: mockFetch, dataDir: dir, config: { ...scanConfig({}), pages: 1 } });
  const saved = readLatest(dir)!;
  assert.equal(saved.pools.length, 3);
  assert.ok(saved.ts && saved.pools[0].address && "feeApr" in saved.pools[0] && "flags" in saved.pools[0]);
  assert.ok(!("raw" in saved.pools[0]));
  const t = scanText(r);
  assert.match(t, /Scan pool DLMM/);
  assert.match(t, /TVL \$200\.0K/);
  assert.match(t, /bukan saran, tidak ada transaksi/);
});
test("HTTP: off without token; bearer required", async () => {
  assert.equal(startScanHttp({}), null);
  assert.ok(authOk("Bearer s3cret", "s3cret"));
  assert.ok(!authOk("Bearer nope", "s3cret") && !authOk(undefined, "s3cret"));
  const srv = http.createServer(scanHandler("s3cret", () => ({ ts: "t", pools: [] }) as never)).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as { port: number }).port;
  const get = (h: Record<string, string> = {}, p = "/scan/latest") => fetch(`http://127.0.0.1:${port}${p}`, { headers: h }).then((x) => x.status);
  assert.equal(await get(), 401);
  assert.equal(await get({ authorization: "Bearer s3cret" }), 200);
  assert.equal(await get({ authorization: "Bearer s3cret" }, "/other"), 404);
  srv.close();
});

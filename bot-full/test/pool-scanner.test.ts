import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { PublicKey } from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";
import {
  runScan,
  rank,
  scanConfig,
  riskFlags,
  mapPool,
  scorePool,
  readLatest,
  hardRejectCheap,
  hardRejectMeta,
  parseBlacklistMints,
  SOL,
} from "../src/scan/scanner.js";
import { parseMintAuthorities, type TokenMeta, type RpcLike } from "../src/scan/token-meta.js";
import { scanText } from "../src/scan/format.js";
import { scanHandler, authOk, startScanHttp } from "../src/scan/http.js";

const now = Date.now();

function mintBuf(opts: { mintAuth?: boolean; freezeAuth?: boolean; supply?: bigint; decimals?: number } = {}): Buffer {
  const b = Buffer.alloc(MintLayout.span);
  const decoded = MintLayout.decode(b);
  // MintLayout.encode needs a full object — build manually via layout fields
  const data = {
    mintAuthorityOption: opts.mintAuth ? 1 : 0,
    mintAuthority: PublicKey.default,
    supply: opts.supply ?? 1_000_000_000_000n,
    decimals: opts.decimals ?? 6,
    isInitialized: true,
    freezeAuthorityOption: opts.freezeAuth ? 1 : 0,
    freezeAuthority: PublicKey.default,
  };
  // @solana/spl-token MintLayout.encode
  const out = Buffer.alloc(MintLayout.span);
  MintLayout.encode(data as never, out);
  return out;
}

const pool = (o: Record<string, unknown> = {}) => ({
  address: "A",
  token_x: {
    address: "Tok111111111111111111111111111111111111111",
    symbol: "TOK",
    is_verified: true,
    holders: 5000,
    freeze_authority_disabled: true,
  },
  token_y: { address: SOL, symbol: "SOL" },
  tvl: 50_000,
  volume: { "24h": 1_000_000 },
  fees: { "24h": 5_000 },
  fee_tvl_ratio: { "24h": 2.5 },
  pool_config: { bin_step: 125, base_fee_pct: 0.8 },
  created_at: now - 30 * 86400e3,
  is_blacklisted: false,
  ...o,
});

function okMeta(partial: Partial<TokenMeta> = {}): TokenMeta {
  return {
    mint: "Tok111111111111111111111111111111111111111",
    hasMintAuthority: false,
    hasFreezeAuthority: false,
    top10HolderPct: 12,
    marketCapUsd: 2_000_000,
    supplyUi: 1_000_000,
    sources: { mintAuthority: "test", freezeAuthority: "test", top10: "test", marketCap: "test" },
    failures: [],
    ...partial,
  };
}

test("config defaults + env override (incl. new Syra thresholds)", () => {
  const c = scanConfig({});
  assert.equal(c.minTvl, 10_000);
  assert.equal(c.maxTvl, 100_000);
  assert.equal(c.minVol24h, 25_000);
  assert.equal(c.minBinStep, 100);
  assert.equal(c.maxBinStep, 200);
  assert.equal(c.topN, 15);
  assert.equal(c.pages, 3);
  assert.equal(c.minPoolAgeHours, 6);
  assert.equal(c.minHolders, 1000);
  assert.equal(c.maxTop10HolderPct, 20);
  assert.equal(c.minMarketCap, 500_000);
  assert.equal(c.excludeFreezeAuth, true);
  assert.equal(c.excludeMintAuth, true);
  assert.equal(c.excludeUnverified, false);
  assert.deepEqual(c.blacklistMints, []);
  assert.equal(c.intervalMinutes, 10);
  assert.equal(scanConfig({ SCAN_MIN_TVL: "50000", SCAN_TOP_N: "99" }).topN, 50);
  assert.equal(scanConfig({ SCAN_MAX_TVL: "80000" }).maxTvl, 80_000);
  assert.equal(scanConfig({ SCAN_MIN_BIN_STEP: "100" }).minBinStep, 100);
  assert.deepEqual(parseBlacklistMints("Aaa1111111111111111111111111111111111111111, Bbb1111111111111111111111111111111111111111"), [
    "Aaa1111111111111111111111111111111111111111",
    "Bbb1111111111111111111111111111111111111111",
  ]);
});

test("hardRejectCheap: TVL max, age, holders, bin, blacklist mint", () => {
  const c = scanConfig({});
  const base = mapPool(pool(), now)!;
  assert.equal(hardRejectCheap(base, c), null);

  assert.match(hardRejectCheap(mapPool(pool({ tvl: 150_000 }), now)!, c)!, /tvl_above_max/);
  assert.match(hardRejectCheap(mapPool(pool({ tvl: 5_000 }), now)!, c)!, /tvl_below_min/);
  assert.match(hardRejectCheap(mapPool(pool({ created_at: now - 2 * 3600e3 }), now)!, c)!, /pool_age_below_min/);
  assert.match(hardRejectCheap(mapPool(pool({ created_at: null }), now)!, c)!, /pool_age_missing/);
  assert.match(
    hardRejectCheap(
      mapPool(pool({ token_x: { address: "Tok111111111111111111111111111111111111111", symbol: "T", holders: 50, is_verified: true } }), now)!,
      c,
    )!,
    /holders_below_min/,
  );
  assert.match(
    hardRejectCheap(
      mapPool(pool({ token_x: { address: "Tok111111111111111111111111111111111111111", symbol: "T", is_verified: true } }), now)!,
      c,
    )!,
    /holders_missing/,
  );
  assert.match(hardRejectCheap(mapPool(pool({ pool_config: { bin_step: 80, base_fee_pct: 1 } }), now)!, c)!, /bin_step/);
  assert.match(hardRejectCheap(mapPool(pool({ pool_config: { bin_step: 250, base_fee_pct: 1 } }), now)!, c)!, /bin_step/);

  const bl = scanConfig({ SCAN_BLACKLIST_MINTS: "Tok111111111111111111111111111111111111111" });
  assert.match(hardRejectCheap(base, bl)!, /blacklist_mint/);

  // unverified kept by default
  const unver = mapPool(
    pool({ token_x: { address: "Tok111111111111111111111111111111111111111", symbol: "U", holders: 2000, is_verified: false } }),
    now,
  )!;
  assert.equal(hardRejectCheap(unver, c), null);
  assert.match(hardRejectCheap(unver, scanConfig({ SCAN_EXCLUDE_UNVERIFIED: "true" }))!, /unverified/);
});

test("hardRejectMeta: freeze/mint authority, top10, market cap, required-fetch failure", () => {
  const c = scanConfig({});
  const m = mapPool(pool(), now)!;
  assert.equal(hardRejectMeta(m, c, okMeta()), null);

  assert.match(hardRejectMeta(m, c, undefined)!, /meta_missing/);
  assert.match(hardRejectMeta(m, c, okMeta({ hasMintAuthority: true }))!, /mint_authority_enabled/);
  assert.match(hardRejectMeta(m, c, okMeta({ hasFreezeAuthority: true }))!, /freeze_authority_enabled/);
  assert.match(hardRejectMeta(m, c, okMeta({ top10HolderPct: 35 }))!, /top10_holder_pct/);
  assert.match(hardRejectMeta(m, c, okMeta({ marketCapUsd: 100_000 }))!, /market_cap_below_min/);

  assert.match(
    hardRejectMeta(m, c, okMeta({ top10HolderPct: null, failures: ["top10"], sources: { top10: "rpc:error" } }))!,
    /meta_top10_failed/,
  );
  assert.match(
    hardRejectMeta(m, c, okMeta({ marketCapUsd: null, failures: ["marketCap"], sources: { marketCap: "unavailable" } }))!,
    /meta_market_cap_failed/,
  );
  assert.match(
    hardRejectMeta(
      m,
      c,
      okMeta({ hasMintAuthority: null, hasFreezeAuthority: null, failures: ["mint_account"], sources: { mintAuthority: "rpc:missing" } }),
    )!,
    /meta_mint_account_failed/,
  );
});

test("parseMintAuthorities reads mint/freeze option bits", () => {
  const a = parseMintAuthorities(mintBuf({ mintAuth: false, freezeAuth: false }));
  assert.equal(a.hasMintAuthority, false);
  assert.equal(a.hasFreezeAuthority, false);
  const b = parseMintAuthorities(mintBuf({ mintAuth: true, freezeAuth: true }));
  assert.equal(b.hasMintAuthority, true);
  assert.equal(b.hasFreezeAuthority, true);
});

test("rank with meta: SOL-only, filters, score, risk flags (no FREEZE/UNVERIFIED hard-pass)", () => {
  const rows = [
    pool({ address: "GOOD", fees: { "24h": 8_000 }, fee_tvl_ratio: { "24h": 4 } }),
    pool({ address: "LOWTVL", tvl: 12_000, fees: { "24h": 400 }, fee_tvl_ratio: { "24h": 3 }, volume: { "24h": 40_000 } }),
    pool({ address: "NEWISH", created_at: now - 10 * 3600e3 }), // >6h hard, <24h soft NEW_POOL
    pool({ address: "NOSOL", token_y: { address: "USDC", symbol: "USDC" } }),
    pool({ address: "WIDE", pool_config: { bin_step: 400, base_fee_pct: 2 } }),
    pool({ address: "DEAD", volume: { "24h": 100 } }),
    pool({ address: "BL", is_blacklisted: true }),
    pool({ address: "RICH", tvl: 250_000 }),
  ];
  const meta = new Map<string, TokenMeta>([["Tok111111111111111111111111111111111111111", okMeta()]]);
  const r = rank(rows, scanConfig({}), now, meta);
  assert.ok(r.pools.every((p) => ["GOOD", "LOWTVL", "NEWISH"].includes(p.address)));
  assert.ok(!r.pools.some((p) => ["NOSOL", "WIDE", "DEAD", "BL", "RICH"].includes(p.address)));
  assert.equal(r.pools[0].address, "GOOD");
  const flags = (a: string) => r.pools.find((p) => p.address === a)!.flags.map((f) => f.code);
  assert.ok(flags("LOWTVL").includes("LOW_TVL"));
  assert.ok(flags("NEWISH").includes("NEW_POOL"));
  assert.ok(r.dropped.some((d) => d.address === "RICH" && /tvl_above_max/.test(d.reason)));
  // unverified does not appear as risk flag anymore; freeze is hard-filter via meta
  for (const p of r.pools) assert.ok(!p.flags.some((f) => f.code === "FREEZE_AUTH" || f.code === "UNVERIFIED"));
});

test("LOW_FEE_VOL flag + score bounds", () => {
  const m = mapPool(pool({ fees: { "24h": 100 } }), now)!;
  assert.ok(riskFlags(m, scanConfig({})).some((f) => f.code === "LOW_FEE_VOL"));
  assert.ok(scorePool({ feeApr: 1e6, fees24h: 1e9, vol24h: 1e9, tvl: 1e9 }, 0) === 100);
  assert.equal(scorePool({ feeApr: 0, fees24h: 0, vol24h: 0, tvl: 0 }, 3), 0);
});

test("runScan with injected meta writes latest.json; text shows TVL band", async () => {
  const rows = [pool({ address: "GOOD" }), pool({ address: "NOSOL", token_y: { address: "USDC", symbol: "USDC" } })];
  const mockFetch = (async () => new Response(JSON.stringify({ data: rows }), { status: 200 })) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  const meta = new Map([["Tok111111111111111111111111111111111111111", okMeta()]]);
  const r = await runScan({
    fetchFn: mockFetch,
    dataDir: dir,
    config: { ...scanConfig({}), pages: 1 },
    metaMap: meta,
  });
  const saved = readLatest(dir)!;
  assert.equal(saved.pools.length, 1);
  assert.equal(saved.pools[0].address, "GOOD");
  assert.ok(saved.pools[0].meta?.marketCapUsd === 2_000_000);
  assert.ok(!("raw" in saved.pools[0]));
  const t = scanText(r);
  assert.match(t, /TVL \$10\.0K–\$100\.0K/);
  assert.match(t, /bukan saran, tidak ada transaksi/);
});

test("runScan: required meta fetch failure drops pool with reason (no invent)", async () => {
  const rows = [pool({ address: "NEEDMETA" })];
  const mockFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("datapi.meteora")) return new Response(JSON.stringify({ data: rows }), { status: 200 });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  const rpc: RpcLike = {
    async getAccountInfo() {
      throw new Error("rpc down");
    },
    async getTokenLargestAccounts() {
      throw new Error("rpc down");
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  const r = await runScan({
    fetchFn: mockFetch,
    dataDir: dir,
    config: { ...scanConfig({}), pages: 1 },
    rpc,
  });
  assert.equal(r.pools.length, 0);
  assert.ok(r.dropped?.some((d) => d.address === "NEEDMETA" && /meta_mint_account_failed|rpc/.test(d.reason)));
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

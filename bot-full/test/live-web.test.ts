import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDemoSnapshot,
  demoActiveFrac,
  mintLiveToken,
  getLiveSession,
  resetLiveSessionsForTests,
  pruneSessions,
  readLiveWebConfig,
  startLiveWebServer,
  stopLiveWebServer,
  createDemoLiveViewUrl,
  createLiveViewUrl,
  isLiveWebRunning,
  barsFromRange,
  snapshotFromLivePosition,
} from "../src/live-web/index.js";
import { __hubTestReset, __hubClientCount, subscribe, setLiveSnapshotFetcher } from "../src/live-web/hub.js";

test("LIVE_WEB_ENABLED defaults false", () => {
  const c = readLiveWebConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.port, 8788);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(readLiveWebConfig({ LIVE_WEB_ENABLED: "true" }).enabled, true);
  assert.equal(readLiveWebConfig({ LIVE_WEB_ENABLED: "TRUE" }).enabled, true);
  assert.equal(readLiveWebConfig({ LIVE_WEB_ENABLED: "1" }).enabled, false);
});

test("demo snapshot marked DEMO + moves over time", () => {
  const a = buildDemoSnapshot({ now: 1_000_000 });
  const b = buildDemoSnapshot({ now: 1_000_000 + 12_000 });
  assert.equal(a.demo, true);
  assert.ok(a.bins.length >= 20);
  assert.match(a.pnlText, /\$|Rp|SOL/);
  assert.notEqual(a.activeBinId, b.activeBinId);
  // edge visits in the loop
  const fracs = [0, 0.22, 0.5, 0.74, 0.9].map((u) => demoActiveFrac(u * 40_000));
  assert.ok(fracs.some((f) => f < 0));
  assert.ok(fracs.some((f) => f > 1));
});

test("opaque tokens hide wallet; prune idle", () => {
  resetLiveSessionsForTests();
  const s = mintLiveToken({
    demo: false,
    position: "Pos1111111111111111111111111111111111111111",
    pool: "Pool2222222222222222222222222222222222222222",
    currency: "USD",
  });
  assert.equal(s.token.length >= 24, true);
  assert.doesNotMatch(s.token, /Pos111|Pool222|private|secret/i);
  assert.ok(getLiveSession(s.token));
  assert.equal(getLiveSession("nope"), null);
  s.lastSeenAt = Date.now() - 40 * 60_000;
  assert.equal(pruneSessions(30 * 60_000), 1);
  assert.equal(getLiveSession(s.token), null);
});

test("barsFromRange + snapshotFromLivePosition read-only shape", () => {
  const bars = barsFromRange(100, 140);
  assert.ok(bars.length >= 2);
  assert.equal(bars[0].binId, 100);
  const snap = snapshotFromLivePosition(
    {
      position: "7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg",
      pool: "Pool2222222222222222222222222222222222222222",
      pair: "BONK/SOL",
      total_value_usd: 100,
      unclaimed_fees_usd: 1.5,
      pnl_usd: 2,
      pnl_pct: 2,
      in_range: true,
      active_id: 120,
      min_bin: 100,
      max_bin: 140,
      min_price: 0.001,
      max_price: 0.002,
      active_price: 0.0015,
    },
    { currency: "USD" },
  );
  assert.equal(snap.demo, false);
  assert.equal(snap.positionShort.includes("…"), true);
  assert.doesNotMatch(JSON.stringify(snap), /7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg/);
  assert.match(snap.pnlText, /\$/);
});

test("server gated; SSE demo stream; URLs only when enabled", async () => {
  resetLiveSessionsForTests();
  __hubTestReset();
  await stopLiveWebServer();
  assert.equal(await startLiveWebServer({ LIVE_WEB_ENABLED: "false" }), null);
  assert.equal(isLiveWebRunning(), false);
  assert.equal(createDemoLiveViewUrl(), null);

  const cfg = await startLiveWebServer(
    { LIVE_WEB_ENABLED: "true", LIVE_WEB_HOST: "127.0.0.1", LIVE_WEB_PORT: "8799" },
    { port: 8799, host: "127.0.0.1", publicBaseUrl: "http://127.0.0.1:8799", enabled: true },
  );
  assert.ok(cfg);
  assert.equal(isLiveWebRunning(), true);
  const demoUrl = createDemoLiveViewUrl("USD");
  assert.ok(demoUrl?.includes("/v/"));
  const token = demoUrl!.split("/v/")[1];

  const health = await fetch("http://127.0.0.1:8799/health");
  assert.equal(health.status, 200);

  const html = await fetch(demoUrl!);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Live Bins/);

  const snap = await fetch(`http://127.0.0.1:8799/api/snapshot/${token}`);
  assert.equal(snap.status, 200);
  const body = (await snap.json()) as { demo: boolean; bins: unknown[] };
  assert.equal(body.demo, true);
  assert.ok(body.bins.length > 0);

  // invalid token
  assert.equal((await fetch("http://127.0.0.1:8799/api/snapshot/not-a-token")).status, 404);

  // SSE: first event arrives
  const ac = new AbortController();
  const esRes = await fetch(`http://127.0.0.1:8799/api/stream/${token}`, { signal: ac.signal });
  assert.equal(esRes.status, 200);
  assert.match(esRes.headers.get("content-type") || "", /text\/event-stream/);
  const reader = esRes.body!.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /data: /);
  ac.abort();
  try {
    await reader.cancel();
  } catch {
    /* */
  }

  // real URL still never embeds full wallet key material
  const real = createLiveViewUrl({
    position: "7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg",
    pool: "PoolX",
    currency: "IDR",
  });
  assert.ok(real);
  assert.doesNotMatch(real!, /7b9f6yDv|WALLET|private/i);

  await stopLiveWebServer();
  assert.equal(isLiveWebRunning(), false);
  __hubTestReset();
  resetLiveSessionsForTests();
});

test("hub polls only while subscribers exist", async () => {
  resetLiveSessionsForTests();
  __hubTestReset();
  let fetches = 0;
  setLiveSnapshotFetcher(async () => {
    fetches++;
    return buildDemoSnapshot();
  });
  const s = mintLiveToken({
    demo: false,
    position: "Pos1111111111111111111111111111111111111111",
    pool: "Pool2222222222222222222222222222222222222222",
    currency: "USD",
  });
  assert.equal(__hubClientCount(), 0);
  const writes: string[] = [];
  const unsub = subscribe(s.token, {
    token: s.token,
    write: (c) => writes.push(c),
    close: () => undefined,
  });
  assert.equal(__hubClientCount(), 1);
  await new Promise((r) => setTimeout(r, 1700));
  assert.ok(fetches >= 1, `expected poll while subscribed, got ${fetches}`);
  unsub();
  const after = fetches;
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(fetches, after, "no poll without subscribers");
  __hubTestReset();
  resetLiveSessionsForTests();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.DATA_DIR ||= fs.mkdtempSync("/tmp/sr-");
const { swapToSolRobust, retrySwapAll, isRetryableSwapError } = await import("../src/engine/swap-robust.js");
const { isStaleBlockhashError } = await import("../src/engine/executor.js");
const { closeKb, retrySwapText } = await import("../src/telegram/close-ui.js");

const MINT = "2StNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".slice(0, 44);
/** wallet mock: send results scripted; a "landed" send reduces the balance by the quoted amount. */
function mock(script: Array<"ok" | "bh" | "landed-but-error" | "fatal">, startBal: bigint) {
  let bal = startBal;
  const quotes: string[] = [];
  let i = 0;
  const deps = {
    balance: async () => bal,
    quote: async (_m: string, a: string) => (quotes.push(a), { outAmount: "1000000", inAmount: a }),
    build: async (q: unknown) => ({ serialized: "x", encoding: "versioned", label: "swap", q }) as never,
    send: async (tx: { q: { inAmount: string } }) => {
      const s = script[i++] ?? "fatal";
      if (s === "ok" || s === "landed-but-error") bal -= BigInt(tx.q.inAmount);
      if (s === "ok") return { success: true, signatures: [`sig${i}`] };
      if (s === "fatal") return { success: false, signatures: [], error: "Jupiter: no route found" };
      return { success: false, signatures: [], error: "Simulation failed. Message: Transaction simulation failed: Blockhash not found. Logs: []" };
    },
    sleep: async () => {},
  };
  return { deps, quotes, get bal() { return bal; } };
}

test("blockhash-not-found then success: re-quote + rebuild, sells once", async () => {
  const m = mock(["bh", "ok"], 500n);
  const r = await swapToSolRobust(MINT, 500n, m.deps);
  assert.equal(r.success, true);
  assert.equal(r.attempts, 2);
  assert.deepEqual(m.quotes, ["500", "500"]); // fresh quote each try
  assert.equal(m.bal, 0n);
});

test("never double-swaps: error reported but tx landed → balance check stops retry", async () => {
  const m = mock(["landed-but-error", "ok"], 500n);
  const r = await swapToSolRobust(MINT, 500n, m.deps);
  assert.equal(r.success, true);
  assert.equal(m.quotes.length, 1);
  assert.equal(m.bal, 0n);
});

test("only the delta is sold; pre-existing tokens untouched", async () => {
  const m = mock(["bh", "bh", "ok"], 1200n); // user already held 700
  const r = await swapToSolRobust(MINT, 500n, m.deps);
  assert.equal(r.success, true);
  assert.equal(r.attempts, 3);
  assert.equal(m.bal, 700n);
});

test("gives up after 4 tries with leftover mint; non-retryable stops at once", async () => {
  const m = mock(["bh", "bh", "bh", "bh", "ok"], 500n);
  const r = await swapToSolRobust(MINT, 500n, m.deps);
  assert.equal(r.success, false);
  assert.equal(m.quotes.length, 4);
  assert.equal(r.leftoverMint, MINT);
  const f = mock(["fatal"], 500n);
  const r2 = await swapToSolRobust(MINT, 500n, f.deps);
  assert.equal(r2.success, false);
  assert.equal(f.quotes.length, 1);
});

test("🔁 Retry swap sells the full wallet balance; nothing to sell → no tx", async () => {
  const m = mock(["ok"], 900n);
  const r = await retrySwapAll(MINT, m.deps);
  assert.equal(r.success, true);
  assert.deepEqual(m.quotes, ["900"]);
  const e = mock([], 0n);
  const r0 = await retrySwapAll(MINT, e.deps);
  assert.equal(r0.success, true);
  assert.equal(e.quotes.length, 0);
  assert.match(retrySwapText(r0, MINT), /Tidak ada saldo/);
  assert.match(retrySwapText({ success: false, soldAtomic: 0n, estOutLamports: 0n, attempts: 4, error: "Blockhash not found", signatures: [] }, MINT), /gagal 4x/);
});

test("error classification + retry button (no expiry, stateless callback)", () => {
  assert.ok(isRetryableSwapError("Simulation failed. Message: Transaction simulation failed: Blockhash not found."));
  assert.ok(isRetryableSwapError("Tx swap tidak masuk: blockhash kadaluarsa (try 3)"));
  assert.ok(isRetryableSwapError("block height exceeded"));
  assert.ok(!isRetryableSwapError("Jupiter: no route found"));
  assert.ok(isStaleBlockhashError("Transaction simulation failed: Blockhash not found"));
  assert.ok(!isStaleBlockhashError("custom program error: 0x1771"));
  const cbs = JSON.stringify(closeKb("abc", false, [MINT]).inline_keyboard);
  assert.ok(cbs.includes(`"sw:retry:${MINT}"`) && cbs.includes("🔁 Retry swap"));
  assert.ok(`sw:retry:${MINT}`.length <= 64);
  assert.ok(!JSON.stringify(closeKb("abc").inline_keyboard).includes("sw:retry"));
});

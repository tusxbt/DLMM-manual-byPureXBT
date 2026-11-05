import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.DATA_DIR ||= fs.mkdtempSync("/tmp/cc-");
const { concurrentUpdates, withKeyLock, lockPosition, releasePosition, isPositionLocked } = await import("../src/telegram/concurrency.js");
const { getSession, markSession, resetSessionIfUnchanged } = await import("../src/telegram/session.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a long button action (zapout) does not block a pasted CA message", async () => {
  const mw = concurrentUpdates();
  const log: string[] = [];
  const zap = { chat: { id: 1 }, callbackQuery: { data: "confirm:yes:x" } } as never;
  const paste = { chat: { id: 1 }, message: { text: "CA" } } as never;
  const t0 = Date.now();
  await mw(zap, async () => { await sleep(200); log.push("zapout done"); });
  await mw(paste, async () => { log.push("CA handled"); });
  assert.ok(Date.now() - t0 < 50, "middleware returned immediately");
  await sleep(20);
  assert.deepEqual(log, ["CA handled"]);
  await sleep(220);
  assert.deepEqual(log, ["CA handled", "zapout done"]);
});

test("messages in one chat stay ordered; errors are caught", async () => {
  const errs: unknown[] = [];
  const mw = concurrentUpdates((e) => errs.push(e));
  const log: number[] = [];
  const m = (id: number) => ({ chat: { id: 7 }, message: { text: String(id) } }) as never;
  await mw(m(1), async () => { await sleep(50); log.push(1); });
  await mw(m(2), async () => { throw new Error("boom"); });
  await mw(m(3), async () => { log.push(3); });
  await sleep(120);
  assert.deepEqual(log, [1, 3]);
  assert.equal(errs.length, 1);
});

test("per-position lock blocks duplicates; per-mint lock queues same token", async () => {
  assert.ok(lockPosition("u:P1"));
  assert.ok(!lockPosition("u:P1"));
  assert.ok(lockPosition("u:P2")); // other position runs in parallel
  assert.ok(isPositionLocked("u:P1"));
  releasePosition("u:P1"); releasePosition("u:P2");
  assert.ok(lockPosition("u:P1")); releasePosition("u:P1");
  const order: string[] = [];
  const a = withKeyLock("mint:A", async () => { order.push("a1"); await sleep(40); order.push("a2"); });
  const b = withKeyLock("mint:A", async () => { order.push("b"); });
  const c = withKeyLock("mint:B", async () => { order.push("c"); });
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["a1", "c", "a2", "b"]);
  await assert.rejects(withKeyLock("mint:A", async () => { throw new Error("x"); }));
  assert.equal(await withKeyLock("mint:A", async () => 5), 5); // queue continues after an error
});

test("finished close does not wipe a flow the user started meanwhile", () => {
  const key = "chat-9";
  const m1 = markSession(key);
  getSession(key).data.panel = { pool: "new" }; // user pasted a CA → /add panel
  assert.equal(resetSessionIfUnchanged(key, m1), false);
  assert.deepEqual(getSession(key).data.panel, { pool: "new" });
  const m2 = markSession(key);
  assert.equal(resetSessionIfUnchanged(key, m2), true);
  assert.equal(getSession(key).data.panel, undefined);
});

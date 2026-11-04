import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePosition } from "../src/telegram/positions-view.js";
import { getSession, resetSession } from "../src/telegram/session.js";
import { expiredAction, createConfirm, renewConfirm, resetConfirmStoreForTests } from "../src/engine/confirm.js";

const ctx = { chat: { id: 777 }, from: { id: 777 } } as never;
const card = (position: string) => ({ position, pool: "X", pair: "A/SOL" }) as never;

test("position buttons resolve by address after session reset (no expiry)", async () => {
  resetSession("777");
  let loads = 0;
  const load = async () => (loads++, [card("AAA"), card("BBB")]);
  const r = await resolvePosition(ctx, "BBB", false, load);
  assert.equal(r?.index, 1);
  assert.equal(loads, 1);
  // cached: no reload
  assert.equal((await resolvePosition(ctx, "AAA", false, load))?.index, 0);
  assert.equal(loads, 1);
  // closed position → null, not a crash
  assert.equal(await resolvePosition(ctx, "ZZZ", false, load), null);
  assert.ok(getSession("777").data.posList);
});

test("expired confirm never dead-ends", () => {
  resetConfirmStoreForTests();
  assert.deepEqual(expiredAction({ purpose: "remove", payload: {} }), { kind: "renew" });
  assert.deepEqual(expiredAction({ purpose: "claim", payload: {} }), { kind: "renew" });
  assert.deepEqual(expiredAction({ purpose: "zapout", payload: { position: "P" } }), { kind: "zapout", position: "P" });
  assert.deepEqual(expiredAction({ purpose: "add", payload: {} }), { kind: "add" });
  const old = createConfirm({ purpose: "remove", summary: "Exit X", payload: { position: "P" }, ttlMs: -1 });
  const n = renewConfirm(old);
  assert.notEqual(n.id, old.id);
  assert.equal(n.status, "awaiting");
  assert.ok(n.expiresAt > Date.now());
  assert.deepEqual(n.payload, old.payload);
});

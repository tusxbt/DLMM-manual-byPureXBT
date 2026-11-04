import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmKeyboard, addBackKeyboard } from "../src/telegram/menus.js";

const cbs = (kb: { inline_keyboard: unknown[][] }) => kb.inline_keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);

test("add Preview keyboard has Confirm/Cancel + Kembali (cancels this confirm)", () => {
  const c = cbs(confirmKeyboard("abc123", { back: true }));
  assert.deepEqual(c, ["confirm:yes:abc123", "confirm:no:abc123", "ap:pvback:abc123"]);
  assert.ok(!cbs(confirmKeyboard("abc123")).some((x) => x.startsWith("ap:")));
});

test("SOL-short / expired / cancel: Kembali + Preview lagi", () => {
  assert.deepEqual(cbs(addBackKeyboard()), ["ap:back", "ap:deploy"]);
});

test("presentConfirm edits the panel message in place (no new message)", async () => {
  process.env.DATA_DIR ||= (await import("node:fs")).mkdtempSync("/tmp/pv-");
  const { presentConfirm, setAutoConfirm } = await import("../src/telegram/confirm-ui.js");
  const { createConfirm } = await import("../src/engine/confirm.js");
  setAutoConfirm(false);
  const edits: Array<{ id: number; kb: string[] }> = [];
  let replies = 0;
  const ctx = {
    chat: { id: 1 },
    api: { editMessageText: async (_c: number, id: number, _t: string, o: { reply_markup: { inline_keyboard: unknown[][] } }) => edits.push({ id, kb: cbs(o.reply_markup) }) },
    reply: async () => (replies++, { message_id: 99 }),
  } as never;
  const r = createConfirm({ purpose: "add", summary: "x", payload: {} });
  assert.equal(await presentConfirm(ctx, "Preview", r.id, { msgId: 42, back: true }), "prompted");
  assert.equal(replies, 0);
  assert.equal(edits[0].id, 42);
  assert.ok(edits[0].kb.includes(`ap:pvback:${r.id}`));
});

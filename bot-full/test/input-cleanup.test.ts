import { test } from "node:test";
import assert from "node:assert/strict";
import { getSession, resetSession, runAwaitingInput, askPrompt, RETRY } from "../src/telegram/session.js";

const mkApi = () => {
  const deleted: number[] = [];
  return { deleted, api: { deleteMessage: async (_c: number | string, id: number) => void deleted.push(id) } };
};

test("typed value: user message + separate prompt deleted; handler runs once", async () => {
  resetSession("5");
  const { deleted, api } = mkApi();
  let got = "";
  const ctx = { reply: async () => ({ message_id: 70 }) };
  await askPrompt(ctx, "5", "Ketik amount…");
  getSession("5").awaitingText = async (t) => void (got = t);
  assert.equal(await runAwaitingInput("5", "0.5", api, 5, 71), true);
  assert.equal(got, "0.5");
  assert.deepEqual(deleted.sort(), [70, 71]);
  assert.equal(getSession("5").awaitingText, null);
  assert.deepEqual(getSession("5").data.promptMsgIds, []);
});

test("invalid value: message deleted, still waiting (RETRY); no pending → not consumed", async () => {
  resetSession("6");
  const { deleted, api } = mkApi();
  let calls = 0;
  const fn = async (t: string) => (calls++, Number(t) > 0 ? undefined : RETRY);
  getSession("6").awaitingText = fn;
  await runAwaitingInput("6", "abc", api, 6, 80);
  assert.equal(getSession("6").awaitingText, fn);
  await runAwaitingInput("6", "2", api, 6, 81);
  assert.equal(getSession("6").awaitingText, null);
  assert.equal(calls, 2);
  assert.deepEqual(deleted, [80, 81]);
  // no pending input → false (normal message routing, e.g. CA paste / menu)
  assert.equal(await runAwaitingInput("6", "hello", api, 6, 82), false);
  assert.deepEqual(deleted, [80, 81]);
});

test("delete errors are ignored (old messages)", async () => {
  resetSession("7");
  getSession("7").awaitingText = async () => undefined;
  const api = { deleteMessage: async () => { throw new Error("message can't be deleted"); } };
  assert.equal(await runAwaitingInput("7", "1", api, 7, 1), true);
});

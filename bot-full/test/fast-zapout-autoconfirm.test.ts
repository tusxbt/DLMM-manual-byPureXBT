import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { pickAutoFee, applyPriorityFee, AUTO_MIN_MICRO, AUTO_MAX_MICRO } from "../src/engine/priority.js";
import { nonSolMints, formatTiming } from "../src/engine/zapout.js";
import { SOL_MINT } from "../src/config.js";

async function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlmm-auto-"));
  Object.assign(process.env, {
    DLMM_SKIP_ENV_CHMOD: "1", DATA_DIR: dir, ALLOWED_TELEGRAM_USER_IDS: "1", TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_CHAT_ID: "1", RPC_URL: "https://api.mainnet-beta.solana.com",
    WALLET_PRIVATE_KEY: bs58.encode(Keypair.generate().secretKey), DRY_RUN: "true",
  });
  const { resetConfigForTests } = await import("../src/config.js");
  resetConfigForTests();
}

test("pickAutoFee p75 clamped", () => {
  assert.equal(pickAutoFee([]), AUTO_MIN_MICRO);
  assert.equal(pickAutoFee([0, 0]), AUTO_MIN_MICRO);
  assert.equal(pickAutoFee([100_000, 200_000, 300_000, 400_000]), 400_000);
  assert.equal(pickAutoFee([9e9]), AUTO_MAX_MICRO);
});

test("applyPriorityFee inserts after compute ixs / replaces, refuses signed tx", () => {
  const kp = Keypair.generate();
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 }));
  applyPriorityFee(tx, 123);
  assert.equal(tx.instructions.length, 3);
  assert.equal(tx.instructions[1].data[0], 3);
  applyPriorityFee(tx, 456);
  assert.equal(tx.instructions.length, 3);
  assert.equal(tx.instructions[1].data.readBigUInt64LE(1), 456n);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = "11111111111111111111111111111111";
  tx.sign(kp);
  assert.throws(() => applyPriorityFee(tx, 1), /ditandatangani/);
});

test("zapout helpers", () => {
  assert.deepEqual(nonSolMints("TOK", SOL_MINT), ["TOK"]);
  assert.deepEqual(nonSolMints("A", "B"), ["A", "B"]);
  assert.match(formatTiming([["claim+remove+close", 2300], ["swap", 1500]]), /claim\+remove\+close 2\.3s · swap 1\.5s/);
});

test("settings defaults: autoConfirm OFF, priority auto", async () => {
  await env();
  const { loadSettings } = await import("../src/store/settings.js");
  const s = loadSettings();
  assert.equal(s.autoConfirm, false);
  assert.equal(s.priorityFeeMicroLamports, 0);
  assert.equal(s.jupPriorityMaxLamports, 1_000_000);
});

test("presentConfirm: OFF shows buttons; ON runs immediately once", async () => {
  await env();
  const { presentConfirm, setConfirmRunner, setAutoConfirm } = await import("../src/telegram/confirm-ui.js");
  const { createConfirm, getConfirm, markConfirm } = await import("../src/engine/confirm.js");
  const replies: Array<{ text: string; kb: boolean }> = [];
  const ctx = {
    reply: async (text: string, o?: { reply_markup?: unknown }) => (replies.push({ text, kb: !!o?.reply_markup }), { message_id: replies.length }),
  } as never;
  let runs = 0;
  setConfirmRunner(async (_c, req) => {
    runs++;
    markConfirm(req.id, "executed");
  });

  setAutoConfirm(false);
  const r1 = createConfirm({ purpose: "claim", summary: "x", payload: {} });
  assert.equal(await presentConfirm(ctx, "S1", r1.id), "prompted");
  assert.equal(replies.at(-1)!.kb, true);
  assert.equal(runs, 0);

  setAutoConfirm(true);
  // non-close actions ALWAYS prompt even when ON
  for (const purpose of ["add", "swap", "claim", "reshape"] as const) {
    const r = createConfirm({ purpose, summary: "x", payload: {} });
    assert.equal(await presentConfirm(ctx, "P", r.id), "prompted", purpose);
    assert.equal(replies.at(-1)!.kb, true);
  }
  assert.equal(runs, 0);
  const rz = createConfirm({ purpose: "zapout", summary: "x", payload: {} });
  assert.equal(await presentConfirm(ctx, "Z", rz.id), "auto");
  assert.equal(runs, 1);
  const r2 = createConfirm({ purpose: "remove", summary: "x", payload: { reposition: { bins: 40 } } });
  assert.equal(await presentConfirm(ctx, "S2", r2.id), "auto");
  assert.equal(runs, 2);
  assert.match(replies.at(-1)!.text, /⚡ auto/);
  assert.equal(getConfirm(r2.id)?.status, "executed");
  // already processed request is not re-run → falls back to prompt (stale button)
  await presentConfirm(ctx, "S2", r2.id);
  assert.equal(runs, 2);
  setAutoConfirm(false);
});

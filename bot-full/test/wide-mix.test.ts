import { test } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { parsePctRange, computeRange, defaultPanel, sidePct, SINGLE_TX_BINS } from "../src/telegram/add-panel.js";
import { splitMixAmounts, packInstructions } from "../src/engine/dlmm-build.js";
import { parsePctPresets } from "../src/telegram/panels.js";
import { requireStrategy } from "../src/strategies/index.js";

const pool = { pool: "P", name: "X-SOL", bin_step: 100 };

test("pct parsing respects side rules", () => {
  assert.deepEqual(parsePctRange("50", "one_sided_sol"), { down: 50, up: 0 });
  assert.deepEqual(parsePctRange("0-50", "one_sided_sol"), { down: 50, up: 0 });
  assert.deepEqual(parsePctRange("-70%", "one_sided_sol"), { down: 70, up: 0 });
  assert.ok("error" in parsePctRange("-50 +20", "one_sided_sol"));
  assert.deepEqual(parsePctRange("0-50", "one_sided_token"), { down: 0, up: 50 });
  assert.deepEqual(parsePctRange("+40", "one_sided_token"), { down: 0, up: 40 });
  assert.deepEqual(parsePctRange("-50 +20", "two_sided"), { down: 50, up: 20 });
  assert.deepEqual(parsePctRange("-50..+20", "two_sided"), { down: 50, up: 20 });
  assert.deepEqual(parsePctRange("30", "two_sided"), { down: 30, up: 30 });
  assert.ok("error" in parsePctRange("100", "one_sided_sol"));
  assert.ok("error" in parsePctRange("abc", "two_sided"));
  assert.deepEqual(sidePct("one_sided_token", { down: 50, up: 0 }), { down: 0, up: 50 });
});

test("pct → bins from bin step, wide allowed, clamp to 1399", () => {
  const base = { ...defaultPanel(pool), side: "one_sided_sol" as const };
  const c = computeRange({ ...base, range: { kind: "pct", down: 50, up: 0 } }, 100, 1);
  assert.equal(c.above, 0);
  assert.equal(c.below, Math.ceil(-Math.log(0.5) / Math.log(1.01))); // 70
  assert.ok(c.total > SINGLE_TX_BINS && !c.error);
  assert.ok(Math.abs(c.downPct - 50) < 1.5);
  const small = computeRange({ ...base, range: { kind: "pct", down: 90, up: 0 } }, 1, 1); // bin step 1bp
  assert.ok(!small.error && small.clamped && small.total === 1399);
  const two = computeRange({ ...base, side: "two_sided", range: { kind: "pct", down: 50, up: 20 } }, 100, 1);
  assert.ok(two.below > 0 && two.above > 0);
});

test("pct presets parsing", () => {
  assert.deepEqual(parsePctPresets("50, 70"), [{ down: 50, up: 0 }, { down: 70, up: 0 }]);
  assert.deepEqual(parsePctPresets("0-50, -40 +10"), [{ down: 50, up: 0 }, { down: 40, up: 10 }]);
  assert.equal(parsePctPresets("1,2,3,4,5"), null);
});

test("mix split 70/30 keeps every lamport", () => {
  const s = splitMixAmounts(new BN(0), new BN(1_000_000_001), 70);
  assert.equal(s.primaryY.toString(), "700000000");
  assert.equal(s.spotY.toString(), "300000001");
  assert.ok(s.primaryY.add(s.spotY).eq(new BN(1_000_000_001)));
  assert.equal(requireStrategy("mix").meteoraKey, "BidAsk");
});

test("packInstructions splits when tx would exceed 1232 bytes", () => {
  const payer = Keypair.generate().publicKey;
  const ixs = Array.from({ length: 40 }, () =>
    new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: PublicKey.unique(), isSigner: false, isWritable: true }], data: Buffer.alloc(16) }),
  );
  const groups = packInstructions(ixs, payer, 2);
  assert.ok(groups.length > 1);
  assert.equal(groups.flat().length, 40);
});

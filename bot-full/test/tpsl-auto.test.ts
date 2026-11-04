import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tpsla-"));
const { setTpsl, setAuto, getTpsl, tpslLine } = await import("../src/store/tpsl.js");
const { scanTpsl, tpslMenu, isArmed, TPSL_INTERVAL_MS, AUTO_WARN } = await import("../src/telegram/tpsl-ui.js");
const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const P = "C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg";

test("auto zapout toggle: default OFF, needs TP/SL, shown in menu + card, warns", () => {
  assert.equal(setAuto(A, true), false);
  setTpsl(A, { tp: 20, pool: P });
  assert.ok(JSON.stringify(tpslMenu({ position: A }, getTpsl(A), 1).kb).includes(`tp:a1:${A}`));
  assert.equal(setAuto(A, true), true);
  assert.match(tpslLine(getTpsl(A))!, /🤖 auto zapout/);
  assert.ok(JSON.stringify(tpslMenu({ position: A }, getTpsl(A), 1).kb).includes("Auto zapout: ON"));
  assert.match(AUTO_WARN, /OTOMATIS/);
  assert.equal(TPSL_INTERVAL_MS, 15_000);
});
test("scan: only armed positions, datapi per pool, auto runs once per trigger; OFF → alert", async () => {
  const pools: string[][] = [];
  const fetchPnl = async (ps: string[]) => (pools.push(ps), new Map([[A, { pnlPct: 25 }]]));
  const autos: string[] = [];
  const sent: string[] = [];
  const h = { send: async (t: string) => void sent.push(t), auto: async (p: { position: string }, why: string) => void autos.push(`${p.position}|${why}`), fetchPnl };
  assert.equal(await scanTpsl(h), 1);
  assert.deepEqual(pools, [[P]]);
  assert.equal(autos.length, 1);
  assert.match(autos[0], /TP \+25%/);
  assert.equal(sent.length, 0);
  assert.equal(isArmed(getTpsl(A)!), false);
  assert.equal(await scanTpsl(h), 0, "not re-triggered");
  assert.equal(pools.length, 1, "no fetch when nothing armed");
  setTpsl(A, { tp: 20 }); // re-arm
  setAuto(A, false);
  assert.equal(await scanTpsl(h), 1);
  assert.equal(autos.length, 1);
  assert.equal(sent.length, 1);
});

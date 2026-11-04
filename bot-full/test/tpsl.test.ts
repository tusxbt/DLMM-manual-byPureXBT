import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tpsl-"));
const { setTpsl, getTpsl, tpslTrigger, markFired, tpslLine } = await import("../src/store/tpsl.js");
const { tpslMenu, alertKeyboard, parsePct } = await import("../src/telegram/tpsl-ui.js");
const { positionKeyboard } = await import("../src/telegram/positions-view.js");
const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

test("trigger fires once per side and re-arms on change", () => {
  const e = setTpsl(A, { tp: 25, sl: 10 });
  assert.equal(e.sl, -10);
  assert.equal(tpslTrigger(e, 10), null);
  assert.equal(tpslTrigger(e, 30), "tp");
  assert.equal(tpslTrigger(e, -12), "sl");
  markFired(A, "tp");
  assert.equal(tpslTrigger(getTpsl(A)!, 40), null);
  setTpsl(A, { tp: 50 });
  assert.equal(tpslTrigger(getTpsl(A)!, 55), "tp");
  assert.equal(tpslTrigger(getTpsl(A)!, null), null);
  assert.equal(tpslLine(getTpsl(A)), "🎯 TP +50% · SL −10%");
  setTpsl(A, { tp: null });
  setTpsl(A, { sl: null });
  assert.equal(getTpsl(A), null);
});
test("UI: Detail has TP/SL; menu + alert buttons route to Preview flows; no auto tx", () => {
  assert.ok(JSON.stringify(positionKeyboard(A)).includes(`tp:m:${A}`));
  const m = tpslMenu({ position: A }, { tp: 25, sl: -10 }, 3.2);
  assert.match(m.text, /TP: \+25% · SL: −10%/);
  assert.ok(JSON.stringify(m.kb).includes(`pv:open:${A}`));
  const k = JSON.stringify(alertKeyboard(A));
  for (const c of [`pv:exit:${A}`, `pv:zap:${A}`, `tp:ign:${A}`]) assert.ok(k.includes(c));
  assert.equal(parsePct("+25%"), 25);
  assert.equal(parsePct("-15"), 15);
  assert.equal(parsePct("abc"), null);
});

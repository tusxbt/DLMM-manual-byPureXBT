import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.DATA_DIR ||= fs.mkdtempSync("/tmp/ps-");
const { applyPresetSlot, presetSlotsKb, resetPresetSlots, amountSlots } = await import("../src/telegram/panels.js");
const { panelKeyboard, defaultPanel } = await import("../src/telegram/add-panel.js");

const base = { binPresets: { narrow: 20, medium: 40, wide: 69 }, amountPresets: [0.5, 1, 2], rangePct: [10, 25, 50, 80] } as never;
const cbs = (kb: { inline_keyboard: unknown[][] }) => kb.inline_keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);

test("each slot editable with validation", () => {
  const a = applyPresetSlot(base, "rp", "1", "30%");
  assert.deepEqual(a.settings!.rangePct, [10, 30, 50, 80]);
  assert.match(applyPresetSlot(base, "rp", "3", "0").error!, /0.1–99/);
  assert.match(applyPresetSlot(base, "rp", "3", "100").error!, /0.1–99/);
  assert.equal(applyPresetSlot(base, "rp", "0", "-12.5").settings!.rangePct[0], 12.5);
  const b = applyPresetSlot(base, "amt", "2", "3,5");
  assert.equal(b.settings!.amountPresets[2], 3.5);
  assert.match(applyPresetSlot(base, "amt", "0", "-1").error!, /> 0/);
  assert.match(applyPresetSlot(base, "amt", "0", "abc").error!, /> 0/);
  assert.equal(applyPresetSlot(base, "amt", "1", "0.25 sol").settings!.amountPresets[1], 0.25);
});

test("keyboard: one button per slot + reset; /add uses custom presets", () => {
  const st = applyPresetSlot(applyPresetSlot(base, "rp", "0", "15").settings!, "amt", "0", "0.3").settings!;
  const c = cbs(presetSlotsKb(st));
  for (const x of ["st:slot:rp:0", "st:slot:rp:1", "st:slot:rp:2", "st:slot:rp:3", "st:slot:amt:0", "st:slot:amt:1", "st:slot:amt:2", "st:pre:reset"]) assert.ok(c.includes(x), x);
  const add = JSON.stringify(panelKeyboard(defaultPanel(), { amountPresets: st.amountPresets, rangePct: st.rangePct }).inline_keyboard);
  assert.ok(add.includes('"-15%"') && add.includes('"0.3"'), add);
  const r = resetPresetSlots(st);
  assert.deepEqual(r.rangePct, [10, 25, 50, 80]);
  assert.deepEqual(r.amountPresets, [0.5, 1, 2]);
  assert.deepEqual(amountSlots({ ...base, amountPresets: [5] } as never), [5, 1, 2]);
});

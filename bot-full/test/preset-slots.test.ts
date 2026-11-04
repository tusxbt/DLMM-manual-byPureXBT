import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.DATA_DIR ||= fs.mkdtempSync("/tmp/ps-");
const { applyPresetSlot, presetSlotsKb, resetPresetSlots, amountSlots } = await import("../src/telegram/panels.js");
const { panelKeyboard, defaultPanel } = await import("../src/telegram/add-panel.js");

const base = { binPresets: { narrow: 20, medium: 40, wide: 69 }, amountPresets: [0.5, 1, 2] } as never;
const cbs = (kb: { inline_keyboard: unknown[][] }) => kb.inline_keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);

test("each slot editable with validation", () => {
  const a = applyPresetSlot(base, "bin", "medium", "120");
  assert.deepEqual(a.settings!.binPresets, { narrow: 20, medium: 120, wide: 69 });
  assert.match(applyPresetSlot(base, "bin", "wide", "0").error!, /1–1399/);
  assert.match(applyPresetSlot(base, "bin", "wide", "2000").error!, /1–1399/);
  assert.match(applyPresetSlot(base, "bin", "wide", "4.5").error!, /bulat/);
  const b = applyPresetSlot(base, "amt", "2", "3,5");
  assert.deepEqual(b.settings!.amountPresets, [0.5, 1, 3.5]);
  assert.match(applyPresetSlot(base, "amt", "0", "-1").error!, /> 0/);
  assert.match(applyPresetSlot(base, "amt", "0", "abc").error!, /> 0/);
  assert.equal(applyPresetSlot(base, "amt", "1", "0.25 sol").settings!.amountPresets[1], 0.25);
});

test("keyboard: one button per slot + reset; /add uses custom presets", () => {
  const st = applyPresetSlot(applyPresetSlot(base, "bin", "narrow", "15").settings!, "amt", "0", "0.3").settings!;
  const c = cbs(presetSlotsKb(st));
  for (const x of ["st:slot:bin:narrow", "st:slot:bin:medium", "st:slot:bin:wide", "st:slot:amt:0", "st:slot:amt:1", "st:slot:amt:2", "st:pre:reset"]) assert.ok(c.includes(x), x);
  const add = JSON.stringify(panelKeyboard(defaultPanel(), { binPresets: st.binPresets, amountPresets: st.amountPresets }).inline_keyboard);
  assert.ok(add.includes('"15b"') && add.includes('"0.3"'), add);
  const r = resetPresetSlots(st);
  assert.deepEqual(r.binPresets, { narrow: 20, medium: 40, wide: 69 });
  assert.deepEqual(r.amountPresets, [0.5, 1, 2]);
  assert.deepEqual(amountSlots({ ...base, amountPresets: [5] } as never), [5, 1, 2]);
});

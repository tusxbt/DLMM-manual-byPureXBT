import path from "node:path";
import { loadConfig } from "../config.js";
import { readJson, writeJsonAtomic, ensureDir } from "./jsonStore.js";

export type Settings = {
  amountPresets: number[];
  rangePresets: { down: number; up: number }[];
};

const DEFAULT: Settings = {
  amountPresets: [0.5, 1, 2],
  rangePresets: [
    { down: 30, up: 0 },
    { down: 40, up: 0 },
    { down: 50, up: 0 },
  ],
};

function settingsPath(): string {
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  ensureDir(cfg.dataDir);
  return path.join(cfg.dataDir, "settings.json");
}

export function loadSettings(): Settings {
  const s = readJson<Settings | null>(settingsPath(), null);
  if (!s) {
    writeJsonAtomic(settingsPath(), DEFAULT);
    return structuredClone(DEFAULT);
  }
  return { ...structuredClone(DEFAULT), ...s };
}

export function saveSettings(settings: Settings): void {
  writeJsonAtomic(settingsPath(), settings);
}

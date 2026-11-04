import path from "node:path";
import { loadConfig } from "../config.js";
import { readJson, writeJsonAtomic, ensureDir } from "./jsonStore.js";

export type TrackedPosition = {
  position: string;
  pool: string;
  pool_name?: string;
  strategy?: string;
  amount_sol?: number;
  min_bin?: number;
  max_bin?: number;
  opened_at?: string;
  alerted?: boolean;
  cost_usd?: number;
  /** active price (SOL per token) at deploy, for PnL card entry marker */
  entry_price?: number;
};

type FileShape = { positions: TrackedPosition[] };

function filePath(): string {
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  ensureDir(cfg.dataDir);
  return path.join(cfg.dataDir, "positions.json");
}

export function loadTrackedPositions(): TrackedPosition[] {
  return readJson<FileShape>(filePath(), { positions: [] }).positions;
}

export function saveTrackedPositions(positions: TrackedPosition[]): void {
  writeJsonAtomic(filePath(), { positions });
}

export function addTrackedPosition(p: TrackedPosition): void {
  const list = loadTrackedPositions();
  list.push(p);
  saveTrackedPositions(list);
}

export function removeTrackedPosition(position: string): void {
  saveTrackedPositions(loadTrackedPositions().filter((p) => p.position !== position));
}

export function setAlerted(position: string, alerted: boolean): void {
  const list = loadTrackedPositions();
  const found = list.find((p) => p.position === position);
  if (found) {
    found.alerted = alerted;
    saveTrackedPositions(list);
  }
}

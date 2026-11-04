/** Per-user TP/SL targets per position (PnL % based). Stored in the scoped DATA_DIR → per user. */
import path from "node:path";
import { loadConfig } from "../config.js";
import { readJson, writeJsonAtomic } from "./jsonStore.js";

export type TpslEntry = { tp?: number | null; sl?: number | null; firedTp?: boolean; firedSl?: boolean; pool?: string; pair?: string };
type File = Record<string, TpslEntry>;

const file = () => path.join(loadConfig({ requireTelegram: false, skipWallet: true }).dataDir, "tpsl.json");
export function loadTpsl(): File {
  return readJson<File>(file(), {});
}
export function getTpsl(position: string): TpslEntry | null {
  const e = loadTpsl()[position];
  return e && (e.tp != null || e.sl != null) ? e : null;
}
/** Set/clear TP or SL. Changing a value re-arms that side. */
export function setTpsl(position: string, patch: { tp?: number | null; sl?: number | null; pool?: string; pair?: string }): TpslEntry {
  const all = loadTpsl();
  const e: TpslEntry = { ...(all[position] || {}) };
  if ("tp" in patch) {
    e.tp = patch.tp ?? null;
    e.firedTp = false;
  }
  if ("sl" in patch) {
    e.sl = patch.sl == null ? null : -Math.abs(patch.sl);
    e.firedSl = false;
  }
  if (patch.pool) e.pool = patch.pool;
  if (patch.pair) e.pair = patch.pair;
  if (e.tp == null && e.sl == null) delete all[position];
  else all[position] = e;
  writeJsonAtomic(file(), all);
  return e;
}
export function markFired(position: string, side: "tp" | "sl"): void {
  const all = loadTpsl();
  if (!all[position]) return;
  if (side === "tp") all[position].firedTp = true;
  else all[position].firedSl = true;
  writeJsonAtomic(file(), all);
}
export function dropTpsl(position: string): void {
  const all = loadTpsl();
  if (!(position in all)) return;
  delete all[position];
  writeJsonAtomic(file(), all);
}

/** Pure: which armed side is hit at this PnL %. */
export function tpslTrigger(e: TpslEntry, pnlPct: number | null | undefined): "tp" | "sl" | null {
  if (pnlPct == null || !Number.isFinite(pnlPct)) return null;
  if (e.tp != null && !e.firedTp && pnlPct >= e.tp) return "tp";
  if (e.sl != null && !e.firedSl && pnlPct <= e.sl) return "sl";
  return null;
}

export const fmtPct = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}%`;
export function tpslLine(e: TpslEntry | null): string | null {
  if (!e) return null;
  const parts = [];
  if (e.tp != null) parts.push(`TP ${fmtPct(e.tp)}${e.firedTp ? " ✓" : ""}`);
  if (e.sl != null) parts.push(`SL ${fmtPct(e.sl)}${e.firedSl ? " ✓" : ""}`);
  return parts.length ? `🎯 ${parts.join(" · ")}` : null;
}

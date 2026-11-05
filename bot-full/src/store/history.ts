/**
 * Realized PnL history — one record per closed position, per user (dataDir/pnl-history.json).
 * Written after every Exit / Zapout / Auto zapout; optional backfill from Meteora datapi.
 */
import path from "node:path";
import { loadConfig } from "../config.js";
import { readJson, writeJsonAtomic, ensureDir } from "./jsonStore.js";
import type { PositionSnapshot } from "../telegram/pnl-send.js";

export type PnlRecord = {
  position: string;
  pool: string;
  pair: string;
  /** token key: mint_x when known, else pair */
  token: string;
  opened_at?: string | null;
  closed_at: string;
  kind: "zapout" | "remove" | "auto" | "import";
  strategy?: string | null;
  capital_usd: number | null;
  exit_usd: number | null;
  fees_usd: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  pnl_sol?: number | null;
  capital_sol?: number | null;
  source: "realized" | "Meteora" | "estimasi";
  /** frozen snapshot → re-render the exact PnL card later */
  snapshot?: PositionSnapshot;
  /** closed_at is approximate (backfill without close time) */
  approx?: boolean;
};

const MAX_RECORDS = 3000;

function file(): string {
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  ensureDir(cfg.dataDir);
  return path.join(cfg.dataDir, "pnl-history.json");
}

export function loadHistory(): PnlRecord[] {
  return readJson<{ records: PnlRecord[] }>(file(), { records: [] }).records;
}

/** Newest first. Same position → replaced (re-close / better data), never duplicated. */
export function addHistory(rec: PnlRecord): void {
  const list = loadHistory().filter((r) => r.position !== rec.position);
  list.push(rec);
  list.sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at));
  writeJsonAtomic(file(), { records: list.slice(0, MAX_RECORDS) });
}

export function mergeImported(recs: PnlRecord[]): number {
  const list = loadHistory();
  const have = new Set(list.map((r) => r.position));
  const add = recs.filter((r) => !have.has(r.position));
  if (!add.length) return 0;
  const all = [...list, ...add].sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at));
  writeJsonAtomic(file(), { records: all.slice(0, MAX_RECORDS) });
  return add.length;
}

// ── pure aggregation (exported for tests) ──

/** YYYY-MM-DD in Asia/Seoul. */
export function kstDay(iso: string | number | Date): string {
  const d = new Date(iso);
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

export type Agg = { key: string; label: string; count: number; wins: number; pnlUsd: number; capitalUsd: number; feesUsd: number; pnlSol: number; unknown: number };

function agg(key: string, label: string, rs: PnlRecord[]): Agg {
  const known = rs.filter((r) => r.pnl_usd != null);
  return {
    key,
    label,
    count: rs.length,
    wins: known.filter((r) => (r.pnl_usd as number) > 0).length,
    pnlUsd: known.reduce((a, r) => a + (r.pnl_usd as number), 0),
    capitalUsd: known.reduce((a, r) => a + (r.capital_usd ?? 0), 0),
    feesUsd: rs.reduce((a, r) => a + (r.fees_usd ?? 0), 0),
    pnlSol: rs.reduce((a, r) => a + (r.pnl_sol ?? 0), 0),
    unknown: rs.length - known.length,
  };
}

export const tokenLabel = (r: Pick<PnlRecord, "pair">) => (r.pair || "?").split(/[/-]/)[0];

/** Per token, sorted by |PnL| desc. */
export function byToken(list: PnlRecord[]): Agg[] {
  const m = new Map<string, PnlRecord[]>();
  for (const r of list) m.set(r.token, [...(m.get(r.token) ?? []), r]);
  return [...m.entries()].map(([k, rs]) => agg(k, tokenLabel(rs[0]), rs)).sort((a, b) => b.pnlUsd - a.pnlUsd);
}

/** Last `days` KST days (oldest → newest), including empty days. */
export function byDay(list: PnlRecord[], days: number, now = new Date()): Agg[] {
  const out: Agg[] = [];
  const today = Date.parse(`${kstDay(now)}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(today - i * 86400e3).toISOString().slice(0, 10);
    out.push(agg(key, key, list.filter((r) => kstDay(r.closed_at) === key)));
  }
  return out;
}

export function winRate(a: Pick<Agg, "wins" | "count" | "unknown">): number | null {
  const n = a.count - a.unknown;
  return n > 0 ? (a.wins / n) * 100 : null;
}

// ── calendar periods (KST) ──
export type PeriodKind = "d" | "w" | "m";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const msOf = (key: string) => Date.parse(`${key}T00:00:00Z`);
export const dayLabel = (k: string, year = false) => `${Number(k.slice(8, 10))} ${MON[Number(k.slice(5, 7)) - 1]}${year ? ` ${k.slice(0, 4)}` : ""}`;

/**
 * Day = KST calendar day; Week = calendar week Monday–Sunday (KST); Month = calendar month.
 * offset 0 = current, −1 = previous, …
 */
export function periodRange(kind: PeriodKind, offset = 0, now = new Date()): { kind: PeriodKind; offset: number; start: string; end: string; days: string[]; label: string } {
  const today = msOf(kstDay(now));
  let s: number, e: number;
  if (kind === "d") {
    s = e = today + offset * 86400e3;
  } else if (kind === "w") {
    const dow = (new Date(today).getUTCDay() + 6) % 7; // Mon=0
    s = today - dow * 86400e3 + offset * 7 * 86400e3;
    e = s + 6 * 86400e3;
  } else {
    const d = new Date(today);
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1);
    s = first;
    e = Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth() + 1, 1) - 86400e3;
  }
  const days: string[] = [];
  for (let t = s; t <= e; t += 86400e3) days.push(keyOf(t));
  const start = keyOf(s), end = keyOf(e);
  const label =
    kind === "d" ? dayLabel(start, true)
    : kind === "w" ? `${dayLabel(start)} – ${dayLabel(end, true)}`
    : `${["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"][Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;
  return { kind, offset, start, end, days, label };
}

export function inPeriod(list: PnlRecord[], p: { start: string; end: string }): PnlRecord[] {
  return list.filter((r) => {
    const k = kstDay(r.closed_at);
    return k >= p.start && k <= p.end;
  });
}

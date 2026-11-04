/**
 * Mobile-friendly message layout: bold header, blank-line separated sections,
 * one fact per short labeled line. Text uses the bot's markdown-ish → HTML (`code`, **bold**).
 */
import { fmtNum, fmtUsd } from "../format.js";

export type Line = string | null | undefined | false;

/** "Label: value" — one fact per line (Telegram uses a proportional font, so no padding). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function kv(label: string, value: string, _pad = 0): string {
  return `${label}: ${value}`;
}

export function section(title: string | null, lines: Line[]): string | null {
  const body = lines.filter((x): x is string => typeof x === "string" && x.length > 0);
  if (!body.length) return null;
  return [title ? `**${title}**` : null, ...body].filter(Boolean).join("\n");
}

export function screen(header: string, ...sections: (string | null)[]): string {
  return [`**${header}**`, ...sections.filter((s): s is string => !!s)].join("\n\n");
}

export const usdOrNa = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? "n/a" : fmtUsd(v));

export function signedUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
}

export function signedPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;
}

export function pnlLine(usd: number | null | undefined, pct: number | null | undefined): string {
  if (usd == null) return "n/a";
  const p = signedPct(pct);
  return `${usd >= 0 ? "🟢" : "🔴"} ${signedUsd(usd)}${p ? ` (${p})` : ""}`;
}

export function sol(v: number, d = 4): string {
  return `${fmtNum(v, d)} SOL`;
}

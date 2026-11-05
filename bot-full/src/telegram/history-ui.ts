/**
 * 📜 Riwayat — realized PnL history: per posisi (re-render PnL card), per token, harian (KST).
 * Menus edit in place; card images are sent as new photos with a back button.
 */
import { InlineKeyboard, InputFile, type Bot, type Context } from "grammy";
import { loadConfig } from "../config.js";
import { log } from "../logger.js";
import { addHistory, byDay, byToken, dayLabel, inPeriod, periodRange, type PeriodKind, kstDay, loadHistory, mergeImported, tokenLabel, winRate, type Agg, type PnlRecord } from "../store/history.js";
import { loadTrackedPositions } from "../store/positions.js";
import { fetchPoolPnl } from "../engine/meteora-pnl.js";
import { renderSummaryCard, type SummaryCardData } from "../render/daily-card.js";
import { buildPnlCardPng, cardDataFromSnapshot, kstStamp, type PositionSnapshot } from "./pnl-send.js";

export const PAGE = 8;

const usd = (n: number | null | undefined, sign = true) =>
  n == null || !Number.isFinite(n) ? "n/a" : `${sign ? (n >= 0 ? "+" : "-") : ""}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number | null | undefined) => (n == null ? "" : ` (${n >= 0 ? "+" : ""}${n.toFixed(2)}%)`);
const dot = (n: number | null | undefined) => (n == null ? "⚪" : n >= 0 ? "🟢" : "🔴");
const shortTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Seoul", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");

// ── record from a finished close (pure; exported for tests) ──
export function recordFromSnapshot(snap: PositionSnapshot, kind: PnlRecord["kind"], closedAt = new Date()): PnlRecord {
  const d = cardDataFromSnapshot(snap, true, closedAt);
  const pair = (snap.pair || d.pair || "TOKEN/SOL").replace("-", "/");
  return {
    position: snap.position,
    pool: snap.pool,
    pair,
    token: snap.mint_x || pair,
    opened_at: snap.opened_at ?? snap.meteora?.openedAt ?? null,
    closed_at: closedAt.toISOString(),
    kind,
    strategy: snap.strategy ?? null,
    capital_usd: d.depositUsd ?? null,
    exit_usd: d.exitUsd ?? null,
    fees_usd: d.feesUsd ?? null,
    pnl_usd: d.pnlUsd ?? null,
    pnl_pct: d.pnlPct ?? null,
    pnl_sol: snap.realized?.pnlSol ?? snap.meteora?.pnlSol ?? null,
    capital_sol: snap.realized?.depositSol ?? null,
    source: (d.source as PnlRecord["source"]) ?? "estimasi",
    snapshot: snap,
  };
}

/** Called after every Exit / Zapout (manual + auto). Never throws. */
export function recordClose(snap: PositionSnapshot | undefined, kind: PnlRecord["kind"]): void {
  if (!snap?.position) return;
  try {
    addHistory(recordFromSnapshot(snap, kind));
  } catch (e) {
    log("history", `record failed: ${(e as Error).message}`, "warn");
  }
}

/** Snapshot for records without one (backfill) so the PnL card still renders. */
function snapOf(r: PnlRecord): PositionSnapshot {
  if (r.snapshot) return r.snapshot;
  return {
    pair: r.pair,
    pool: r.pool,
    position: r.position,
    total_value_usd: r.exit_usd,
    unclaimed_fees_usd: 0,
    cost_usd: r.capital_usd ?? undefined,
    opened_at: r.opened_at ?? undefined,
    strategy: r.strategy ?? null,
    exit_label: "HISTORY",
    meteora: {
      position: r.position, closed: true, pnlUsd: r.pnl_usd, pnlPct: r.pnl_pct, pnlSol: r.pnl_sol ?? null,
      depositUsd: r.capital_usd, withdrawUsd: r.exit_usd == null ? null : r.exit_usd - (r.fees_usd ?? 0), feesUsd: r.fees_usd,
      feeX: { amount: null, usd: null }, feeY: { amount: null, usd: null }, balanceUsd: null, unclaimedFeesUsd: null,
    },
  };
}

// ── texts + keyboards (pure) ──
function aggLine(a: Agg): string {
  const wr = winRate(a);
  return `${dot(a.count ? a.pnlUsd : null)} **${a.label}** · ${usd(a.pnlUsd)} · ${a.count}x${wr == null ? "" : ` · win ${wr.toFixed(0)}%`}`;
}

export function historyHome(list: PnlRecord[], now = new Date()): { text: string; kb: InlineKeyboard } {
  const all = byToken(list).reduce((s, a) => s + a.pnlUsd, 0);
  const d7 = byDay(list, 7, now);
  const today = d7[d7.length - 1];
  const w7 = d7.reduce((s, a) => s + a.pnlUsd, 0);
  const text = [
    "📜 **Riwayat PnL**",
    "",
    `Hari ini: ${usd(today.pnlUsd)} · ${today.count} posisi`,
    `7 hari: ${usd(w7)} · ${d7.reduce((s, a) => s + a.count, 0)} posisi`,
    `Total: ${usd(all)} · ${list.length} posisi`,
    list.length ? "" : "\nBelum ada riwayat. Posisi yang ditutup (Exit / Zapout) tercatat otomatis. Coba 🔄 Sinkron Meteora untuk impor posisi lama.",
  ].join("\n").trim();
  const kb = new InlineKeyboard()
    .text("📍 Per posisi", "hi:pos:0").text("🪙 Per token", "hi:tok:0").row()
    .text("📅 Harian / Minggu / Bulan", "hi:per:d:0").row()
    .text("📋 7 hari", "hi:day:7").text("📋 30 hari", "hi:day:30").row()
    .text("🔄 Sinkron Meteora", "hi:sync").text("🏠", "menu:cancel");
  return { text, kb };
}

export function positionsPage(list: PnlRecord[], page: number, filter?: { token?: string; day?: string }): { text: string; kb: InlineKeyboard } {
  let rs = list;
  if (filter?.token) rs = rs.filter((r) => r.token === filter.token);
  if (filter?.day) rs = rs.filter((r) => kstDay(r.closed_at) === filter.day);
  const pages = Math.max(1, Math.ceil(rs.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = rs.slice(p * PAGE, p * PAGE + PAGE);
  const head = filter?.token ? `🪙 **${tokenLabel(rs[0] ?? { pair: "?" })}**` : filter?.day ? `📅 **${filter.day}**` : "📍 **Per posisi**";
  const lines = slice.map((r, i) => `${p * PAGE + i + 1}. ${dot(r.pnl_usd)} **${r.pair}** · ${usd(r.pnl_usd)}${pct(r.pnl_pct)} · ${shortTime(r.closed_at)}${r.approx ? "≈" : ""}`);
  const kb = new InlineKeyboard();
  slice.forEach((r, i) => {
    kb.text(`🖼 ${p * PAGE + i + 1}. ${tokenLabel(r)} ${usd(r.pnl_usd)}`, `hi:pc:${r.position}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row();
  if (!filter && pages > 1) {
    if (p > 0) kb.text("◀️", `hi:pos:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "hi:noop");
    if (p < pages - 1) kb.text("▶️", `hi:pos:${p + 1}`);
    kb.row();
  }
  kb.text("⬅️ Kembali", filter?.token ? "hi:tok:0" : filter?.day ? "hi:day:7" : "hi:menu").text("🏠", "menu:cancel");
  const body = lines.length ? lines.join("\n") : "Belum ada posisi.";
  return { text: [head, "", body, "", "Tap 🖼 untuk PnL card."].join("\n"), kb };
}

export function tokensPage(list: PnlRecord[], page: number): { text: string; kb: InlineKeyboard } {
  const all = byToken(list);
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(p * PAGE, p * PAGE + PAGE);
  const kb = new InlineKeyboard();
  slice.forEach((a, i) => {
    kb.text(`${a.label} ${usd(a.pnlUsd)}`, `hi:tk:${a.key.slice(0, 56)}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row();
  if (pages > 1) {
    if (p > 0) kb.text("◀️", `hi:tok:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "hi:noop");
    if (p < pages - 1) kb.text("▶️", `hi:tok:${p + 1}`);
    kb.row();
  }
  kb.text("⬅️ Kembali", "hi:menu").text("🏠", "menu:cancel");
  return { text: ["🪙 **Per token**", "", slice.map(aggLine).join("\n") || "Belum ada riwayat."].join("\n"), kb };
}

export function tokenSummary(list: PnlRecord[], key: string): { text: string; kb: InlineKeyboard } {
  const rs = list.filter((r) => r.token === key || r.token.startsWith(key));
  const a = byToken(rs)[0];
  const pos = positionsPage(rs, 0, { token: rs[0]?.token });
  if (!a) return { text: "Token tidak ada di riwayat.", kb: new InlineKeyboard().text("⬅️ Kembali", "hi:tok:0") };
  const wr = winRate(a);
  const head = [
    `🪙 **${a.label}** — ${a.count} posisi`,
    `PnL: ${usd(a.pnlUsd)}${a.capitalUsd ? pct((a.pnlUsd / a.capitalUsd) * 100) : ""}`,
    `Win rate: ${wr == null ? "n/a" : `${wr.toFixed(0)}% (${a.wins}/${a.count - a.unknown})`}`,
    `Modal: ${usd(a.capitalUsd, false)} · Fees: ${usd(a.feesUsd, false)}`,
    key.length > 30 ? `Mint: \`${rs[0].token}\`` : "",
  ].filter(Boolean).join("\n");
  const kb = new InlineKeyboard().text("🖼 PnL card token", `hi:tc:${rs[0].token.slice(0, 56)}`).row();
  for (const row of pos.kb.inline_keyboard) { for (const b of row) kb.add(b); kb.row(); }
  return { text: `${head}\n\n${pos.text.split("\n").slice(2).join("\n")}`, kb };
}

export function daysPage(list: PnlRecord[], days: number, now = new Date()): { text: string; kb: InlineKeyboard } {
  const ds = byDay(list, days, now);
  const tot = ds.reduce((s, a) => s + a.pnlUsd, 0);
  const n = ds.reduce((s, a) => s + a.count, 0);
  const rows = [...ds].reverse().filter((a, i) => a.count || (days <= 7 && i < 7));
  const kb = new InlineKeyboard().text("🖼 Card harian", `hi:dc:${days}`).row();
  rows.filter((a) => a.count).slice(0, 8).forEach((a, i) => {
    kb.text(`${a.key.slice(5)} ${usd(a.pnlUsd)}`, `hi:d:${a.key}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text(days === 7 ? "📅 30 hari" : "📅 7 hari", `hi:day:${days === 7 ? 30 : 7}`).row().text("⬅️ Kembali", "hi:menu").text("🏠", "menu:cancel");
  return {
    text: [
      `📅 **Harian — ${days} hari** (KST)`,
      `Total: ${usd(tot)} · ${n} posisi`,
      "",
      rows.map((a) => `${dot(a.count ? a.pnlUsd : null)} ${a.key} · ${a.count ? `${usd(a.pnlUsd)} · ${a.count}x` : "-"}`).join("\n") || "Belum ada posisi ditutup.",
    ].join("\n"),
    kb,
  };
}

type CardStats = Pick<SummaryCardData, "totalUsd" | "pnlPct" | "pnlSol" | "count" | "wins" | "winRate" | "capitalUsd" | "feesUsd" | "best" | "worst"> & { exitUsd: number | null };
function statsOf(rs: PnlRecord[]): CardStats {
  const known = rs.filter((r) => r.pnl_usd != null);
  const totalUsd = known.reduce((s, r) => s + (r.pnl_usd as number), 0);
  const capitalUsd = known.reduce((s, r) => s + (r.capital_usd ?? 0), 0);
  const solKnown = rs.filter((r) => r.pnl_sol != null);
  const sorted = [...known].sort((a, b) => (b.pnl_usd as number) - (a.pnl_usd as number));
  const wins = known.filter((r) => (r.pnl_usd as number) > 0).length;
  const exits = rs.filter((r) => r.exit_usd != null);
  return {
    totalUsd,
    pnlPct: capitalUsd > 0 ? (totalUsd / capitalUsd) * 100 : null,
    pnlSol: solKnown.length ? solKnown.reduce((s, r) => s + (r.pnl_sol as number), 0) : null,
    count: rs.length,
    wins,
    winRate: known.length ? (wins / known.length) * 100 : null,
    capitalUsd,
    exitUsd: exits.length ? exits.reduce((s, r) => s + (r.exit_usd as number), 0) : null,
    feesUsd: rs.reduce((s, r) => s + (r.fees_usd ?? 0), 0),
    best: sorted[0] ? { label: tokenLabel(sorted[0]), pnlUsd: sorted[0].pnl_usd as number } : null,
    worst: sorted.length > 1 ? { label: tokenLabel(sorted[sorted.length - 1]), pnlUsd: sorted[sorted.length - 1].pnl_usd as number } : null,
  };
}

const KICK: Record<PeriodKind, string> = { d: "Daily PnL", w: "Weekly PnL", m: "Monthly PnL" };

/** Day: one bar per position (close order). Week/Month: one bar per KST day. */
export function periodCardData(list: PnlRecord[], kind: PeriodKind, offset = 0, now = new Date()): SummaryCardData {
  const p = periodRange(kind, offset, now);
  const rs = inPeriod(list, p);
  const st = statsOf(rs);
  const bars =
    kind === "d"
      ? [...rs].sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at)).map((r) => ({ label: tokenLabel(r), pnlUsd: r.pnl_usd ?? 0, empty: r.pnl_usd == null }))
      : p.days.map((k) => {
          const ds = rs.filter((r) => kstDay(r.closed_at) === k);
          return { label: kind === "w" ? `${["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"][(new Date(`${k}T00:00:00Z`).getUTCDay() + 6) % 7]} ${Number(k.slice(8))}` : String(Number(k.slice(8))), pnlUsd: ds.reduce((s, r) => s + (r.pnl_usd ?? 0), 0), empty: ds.length === 0 };
        });
  const { exitUsd: _e, ...rest } = st;
  void _e;
  return {
    kicker: KICK[kind],
    title: p.label,
    ...rest,
    bars,
    barsLabel: kind === "d" ? "PnL per posisi" : kind === "w" ? "PnL per hari (Sen–Min, KST)" : "PnL per hari (KST)",
    footer: `${kind === "d" ? "harian" : kind === "w" ? "mingguan" : "bulanan"} · ${kstStamp(now)}`,
  };
}

/** @deprecated rolling N days (kept for older callers/tests). */
export function periodView(list: PnlRecord[], kind: PeriodKind, offset = 0, now = new Date()): { text: string; kb: InlineKeyboard } {
  const p = periodRange(kind, offset, now);
  const rs = inPeriod(list, p);
  const st = statsOf(rs);
  const name = kind === "d" ? "Hari" : kind === "w" ? "Minggu (Sen–Min)" : "Bulan";
  const lines =
    kind === "d"
      ? rs.slice(0, 15).map((r) => `${dot(r.pnl_usd)} **${r.pair}** · ${usd(r.pnl_usd)}${pct(r.pnl_pct)} · ${shortTime(r.closed_at).slice(-5)}`)
      : p.days.filter((k) => rs.some((r) => kstDay(r.closed_at) === k)).reverse().map((k) => {
          const ds = rs.filter((r) => kstDay(r.closed_at) === k);
          return `${dot(ds.reduce((s, r) => s + (r.pnl_usd ?? 0), 0))} ${dayLabel(k)} · ${usd(ds.reduce((s, r) => s + (r.pnl_usd ?? 0), 0))} · ${ds.length}x`;
        });
  const text = [
    `📅 **${name}: ${p.label}** (KST)`,
    `PnL: ${usd(st.totalUsd)}${pct(st.pnlPct)}${st.pnlSol == null ? "" : ` · ${st.pnlSol >= 0 ? "+" : ""}${st.pnlSol.toFixed(4)} SOL`}`,
    `${st.count} posisi · win ${st.winRate == null ? "n/a" : `${st.winRate.toFixed(0)}%`} · modal ${usd(st.capitalUsd, false)} · fees ${usd(st.feesUsd, false)}`,
    "",
    lines.join("\n") || "Belum ada posisi ditutup.",
  ].join("\n");
  const kb = new InlineKeyboard()
    .text(kind === "d" && offset === 0 ? "• Hari ini" : "Hari ini", "hi:per:d:0")
    .text(kind === "w" && offset === 0 ? "• Minggu ini" : "Minggu ini", "hi:per:w:0")
    .text(kind === "m" && offset === 0 ? "• Bulan ini" : "Bulan ini", "hi:per:m:0")
    .row()
    .text("◀️ Sebelumnya", `hi:per:${kind}:${offset - 1}`);
  if (offset < 0) kb.text("Berikutnya ▶️", `hi:per:${kind}:${offset + 1}`);
  kb.row().text("🖼 PnL card", `hi:pcd:${kind}:${offset}`);
  if (kind === "d" && rs.length) kb.text("📍 Posisi", `hi:d:${p.start}`);
  kb.row().text("⬅️ Kembali", "hi:menu").text("🏠", "menu:cancel");
  return { text, kb };
}

export function dailyCardData(list: PnlRecord[], days: number, now = new Date()): SummaryCardData {
  const ds = byDay(list, days, now);
  const rs = list.filter((r) => ds.some((d) => d.key === kstDay(r.closed_at)));
  const { exitUsd: _e, ...st } = statsOf(rs);
  void _e;
  return { kicker: "Daily PnL", title: `${days} hari terakhir`, ...st, bars: ds.map((a) => ({ label: dayLabel(a.key), pnlUsd: a.pnlUsd, empty: a.count === 0 })), footer: `daily · ${kstStamp(now)}`, days: ds } as SummaryCardData & { days: Agg[] };
}

const fmtDur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}hr ${h}j` : h ? `${h}j ${m % 60}m` : `${m}m`;
};

/** Token aggregate: all positions of one token merged into one card. */
export function tokenCardData(list: PnlRecord[], key: string, now = new Date()): SummaryCardData | null {
  const rs = list.filter((r) => r.token === key || r.token.startsWith(key)).sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at));
  if (!rs.length) return null;
  const st = statsOf(rs);
  const opens = rs.map((r) => (r.opened_at ? Date.parse(r.opened_at) : NaN)).filter(Number.isFinite);
  const durMs = rs.reduce((s, r) => s + (r.opened_at ? Math.max(0, Date.parse(r.closed_at) - Date.parse(r.opened_at)) : 0), 0);
  const first = Math.min(Date.parse(rs[0].closed_at), ...opens);
  const last = Date.parse(rs[rs.length - 1].closed_at);
  const range = `${dayLabel(kstDay(first))} → ${dayLabel(kstDay(last))}`;
  return {
    kicker: "Token PnL",
    title: `${tokenLabel(rs[0])}/SOL`,
    ...st,
    best: null,
    worst: null,
    extra: [["DURASI", opens.length ? fmtDur(durMs) : "n/a"], ["PERIODE", range]],
    bars: rs.map((r, i) => ({ label: `#${i + 1}`, pnlUsd: r.pnl_usd ?? 0, empty: r.pnl_usd == null })),
    barsLabel: "PnL per posisi (urut waktu tutup)",
    footer: `${rs.length} posisi · ${kstStamp(now)}`,
  };
}

// ── backfill from Meteora datapi (pools known locally) ──
export async function backfillFromMeteora(): Promise<{ added: number; pools: number }> {
  const wallet = loadConfig({ requireTelegram: false, skipWallet: true }).walletPublicKey.toBase58();
  const hist = loadHistory();
  const tracked = loadTrackedPositions();
  const pools = [...new Set([...hist.map((r) => r.pool), ...tracked.map((t) => t.pool)])].filter(Boolean);
  const pairOf = (pool: string) =>
    hist.find((r) => r.pool === pool)?.pair || tracked.find((t) => t.pool === pool)?.pool_name?.replace("-", "/") || `${pool.slice(0, 4)}…/SOL`;
  const recs: PnlRecord[] = [];
  for (const pool of pools) {
    try {
      for (const m of (await fetchPoolPnl(pool, wallet, "closed")).values()) {
        if (!m.closed) continue;
        const pair = pairOf(pool);
        recs.push({
          position: m.position, pool, pair, token: hist.find((r) => r.pool === pool)?.token || pair,
          opened_at: m.openedAt ?? null, closed_at: m.closedAt ?? new Date().toISOString(), approx: !m.closedAt,
          kind: "import", strategy: null, capital_usd: m.depositUsd,
          exit_usd: m.withdrawUsd == null ? null : m.withdrawUsd + (m.feesUsd ?? 0), fees_usd: m.feesUsd,
          pnl_usd: m.pnlUsd, pnl_pct: m.pnlPct, pnl_sol: m.pnlSol, source: "Meteora",
        });
      }
    } catch (e) {
      log("history", `backfill ${pool.slice(0, 6)}: ${(e as Error).message}`, "warn");
    }
  }
  return { added: mergeImported(recs), pools: pools.length };
}

// ── telegram ──
async function show(ctx: Context, v: { text: string; kb: InlineKeyboard }): Promise<void> {
  const m = ctx.callbackQuery?.message;
  if (m && !("photo" in m && m.photo)) {
    try {
      await ctx.editMessageText(v.text, { reply_markup: v.kb });
      return;
    } catch (e) {
      if (/not modified/i.test((e as Error).message)) return;
    }
  }
  await ctx.reply(v.text, { reply_markup: v.kb });
}

export async function showHistory(ctx: Context): Promise<void> {
  await show(ctx, historyHome(loadHistory()));
}

export function registerHistoryUi(bot: Bot): void {
  bot.command("history", (ctx) => showHistory(ctx));
  bot.callbackQuery("hi:noop", (ctx) => ctx.answerCallbackQuery());
  bot.callbackQuery("hi:menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showHistory(ctx);
  });
  bot.callbackQuery(/^hi:pos:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, positionsPage(loadHistory(), Number(ctx.match![1])));
  });
  bot.callbackQuery(/^hi:tok:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, tokensPage(loadHistory(), Number(ctx.match![1])));
  });
  bot.callbackQuery(/^hi:tk:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, tokenSummary(loadHistory(), ctx.match![1]));
  });
  bot.callbackQuery(/^hi:day:(7|30)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, daysPage(loadHistory(), Number(ctx.match![1])));
  });
  bot.callbackQuery(/^hi:d:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const v = positionsPage(loadHistory(), 0, { day: ctx.match![1] });
    v.kb.row().text("🖼 Card hari ini", `hi:d1:${ctx.match![1]}`);
    await show(ctx, v);
  });
  bot.callbackQuery(/^hi:(dc:(7|30)|d1:(\d{4}-\d{2}-\d{2}))$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🖼 Render…" });
    try {
      const list = loadHistory();
      const day = ctx.match![3];
      const days = day ? 1 : Number(ctx.match![2]);
      const now = day ? new Date(`${day}T12:00:00+09:00`) : new Date();
      const d = dailyCardData(list, days, now);
      const png = renderSummaryCard(d);
      await ctx.replyWithPhoto(new InputFile(png, "daily.png"), {
        caption: `📅 ${d.title} · ${usd(d.totalUsd)} · ${d.count} posisi`,
        reply_markup: new InlineKeyboard().text("⬅️ Riwayat", "hi:menu"),
      });
    } catch (e) {
      await ctx.reply(`❌ Card gagal: ${(e as Error).message.slice(0, 200)}`);
    }
  });
  bot.callbackQuery(/^hi:per:([dwm]):(-?\d{1,3})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, periodView(loadHistory(), ctx.match![1] as PeriodKind, Math.min(0, Number(ctx.match![2]))));
  });
  const sendCard = async (ctx: Context, d: SummaryCardData | null, back: string) => {
    if (!d) return void (await ctx.reply("Tidak ada data."));
    try {
      await ctx.replyWithPhoto(new InputFile(renderSummaryCard(d), "pnl-summary.png"), {
        caption: `📈 ${d.kicker} · ${d.title} · ${usd(d.totalUsd)}${pct(d.pnlPct)} · ${d.count} posisi`,
        reply_markup: new InlineKeyboard().text("⬅️ Kembali", back).text("📜 Riwayat", "hi:menu"),
      });
    } catch (e) {
      await ctx.reply(`❌ Card gagal: ${(e as Error).message.slice(0, 200)}`);
    }
  };
  bot.callbackQuery(/^hi:pcd:([dwm]):(-?\d{1,3})$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🖼 Render…" });
    const k = ctx.match![1] as PeriodKind, o = Math.min(0, Number(ctx.match![2]));
    await sendCard(ctx, periodCardData(loadHistory(), k, o), `hi:per:${k}:${o}`);
  });
  bot.callbackQuery(/^hi:tc:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🖼 Render…" });
    await sendCard(ctx, tokenCardData(loadHistory(), ctx.match![1]), `hi:tk:${ctx.match![1]}`.slice(0, 64));
  });
  bot.callbackQuery(/^hi:pc:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🖼 Render PnL card…" });
    const r = loadHistory().find((x) => x.position === ctx.match![1]);
    if (!r) return void (await ctx.reply("Posisi tidak ada di riwayat."));
    const kb = new InlineKeyboard().text("⬅️ Per posisi", "hi:pos:0").text("📜 Riwayat", "hi:menu");
    const cap = `📈 **${r.pair}** · closed ${shortTime(r.closed_at)} KST · PnL ${usd(r.pnl_usd)}${pct(r.pnl_pct)}`;
    try {
      const png = await buildPnlCardPng({ ...snapOf(r), exit_label: r.kind === "import" ? "HISTORY" : r.snapshot?.exit_label ?? r.kind.toUpperCase() }, true, new Date(r.closed_at));
      await ctx.replyWithPhoto(new InputFile(png, "pnl.png"), { caption: cap, reply_markup: kb });
    } catch (e) {
      await ctx.reply(`${cap}\n(card gagal: ${(e as Error).message.slice(0, 120)})`, { reply_markup: kb });
    }
  });
  bot.callbackQuery("hi:sync", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🔄 Sinkron…" });
    try {
      const r = await backfillFromMeteora();
      const v = historyHome(loadHistory());
      v.text += `\n\n🔄 Sinkron Meteora: +${r.added} posisi (${r.pools} pool dicek).`;
      await show(ctx, v);
    } catch (e) {
      await ctx.reply(`❌ Sinkron gagal: ${(e as Error).message.slice(0, 200)}`);
    }
  });
}

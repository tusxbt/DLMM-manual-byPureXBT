/**
 * Shared PnL-card background — ONE asset path for every card
 * (per-position, daily, weekly, monthly, per-token).
 *
 * Resolution order (first hit wins):
 *   1. explicit `background` path passed to the renderer
 *   2. per-user upload: DATA_DIR/users/<id>/pnl-bg.jpg  (via caller / bgForCurrentUser)
 *   3. env PNL_BG_PATH
 *   4. bundled assets/pnl-bg.jpg (optional)
 *
 * To change the look for ALL cards: replace that one image (user upload in Settings,
 * or set PNL_BG_PATH / drop assets/pnl-bg.jpg). No per-card code edits.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");
export const BUNDLED_PNL_BG = path.join(ASSETS, "pnl-bg.jpg");

const bgCache = new Map<string, Image | null>();

export type CardBgOpts = {
  background?: string | null;
  bgDarkPct?: number | null;
  bgBlur?: number | null;
};

const bgFile = (p?: string | null) => {
  const explicit = (p || "").trim();
  if (explicit) return explicit;
  const env = process.env.PNL_BG_PATH?.trim();
  if (env) return env;
  return fs.existsSync(BUNDLED_PNL_BG) ? BUNDLED_PNL_BG : "";
};

const bgKey = (f: string) => {
  try {
    return `${f}@${fs.statSync(f).mtimeMs}`;
  } catch {
    return `${f}@none`;
  }
};

/** Decode background (async in napi-rs). Call before render. Never throws. Cache by mtime. */
export async function preloadPnlBackground(p?: string | null): Promise<void> {
  const f = bgFile(p);
  if (!f) return;
  const k = bgKey(f);
  if (bgCache.has(k)) return;
  try {
    bgCache.set(k, fs.existsSync(f) ? await loadImage(f) : null);
  } catch {
    bgCache.set(k, null);
  }
}

export function loadBg(p?: string | null): Image | null {
  const f = bgFile(p);
  return f ? (bgCache.get(bgKey(f)) ?? null) : null;
}

/** Fill canvas with #0b0f14, optional cover-fitted background + dark overlay. */
export function paintCardBackground(
  ctx: SKRSContext2D,
  W: number,
  H: number,
  opts: CardBgOpts = {},
): void {
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, W, H);
  const bg = loadBg(opts.background);
  if (!bg) return;
  const k = Math.max(W / bg.width, H / bg.height);
  const blur = Math.max(0, Math.min(30, opts.bgBlur ?? Number(process.env.PNL_BG_BLUR ?? 0)));
  if (blur > 0) ctx.filter = `blur(${blur}px)`;
  const m = blur * 2;
  ctx.drawImage(bg, (W - bg.width * k) / 2 - m, (H - bg.height * k) / 2 - m, bg.width * k + 2 * m, bg.height * k + 2 * m);
  ctx.filter = "none";
  const dark = Math.max(20, Math.min(95, opts.bgDarkPct ?? 70)) / 100;
  ctx.fillStyle = `rgba(11,15,20,${dark})`;
  ctx.fillRect(0, 0, W, H);
}

/** Clear decode cache (tests). */
export function resetBgCache(): void {
  bgCache.clear();
}

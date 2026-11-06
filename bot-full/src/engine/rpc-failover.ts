/**
 * Multi-RPC failover: rotate on 429 / 5xx / timeout / network errors.
 * Logs only show rpc#N — never the URL or API key.
 */
import { log } from "../logger.js";

export const RPC_COOLDOWN_MS = 45_000;
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/** True if value is a usable http(s) RPC endpoint (rejects "", "undefined", "null"). */
export function isValidRpcUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  const s = u.trim();
  if (!s || s === "undefined" || s === "null") return false;
  try {
    const x = new URL(s);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch {
    return false;
  }
}

/** Parse RPC_URLS (comma-separated) or fall back to a single RPC_URL. Deduped, order kept. */
export function parseRpcUrls(urlsEnv?: string | null, single?: string | null): string[] {
  const raw = String(urlsEnv ?? "").trim()
    ? String(urlsEnv).split(",")
    : String(single ?? "").includes(",")
      ? String(single).split(",")
      : [String(single ?? "")];
  const list = raw.map((s) => s.trim()).filter(isValidRpcUrl);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of list) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  if (!out.length) out.push(DEFAULT_RPC);
  return out;
}

export function rpcLabel(index: number): string {
  return `rpc#${index + 1}`;
}

export function isFailoverHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isFailoverErrorMessage(msg: string): boolean {
  return /429|too many requests|rate limit|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up|aborted|timeout|timed?\s*out|Failed to parse URL|503|502|504|520|521|522|523|524/i.test(
    msg,
  );
}

type FetchFn = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export type RpcFailoverOpts = {
  cooldownMs?: number;
  fetchFn?: FetchFn;
  now?: () => number;
  onSwitch?: (from: number, to: number, reason: string) => void;
};

export class RpcFailover {
  readonly urls: string[];
  private idx = 0;
  private coolUntil: number[];
  private readonly cooldownMs: number;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly onSwitch?: (from: number, to: number, reason: string) => void;

  constructor(urls: string[], opts: RpcFailoverOpts = {}) {
    const clean = urls.filter(isValidRpcUrl);
    if (!clean.length) throw new Error("RpcFailover: no RPC URLs");
    this.urls = clean;
    this.coolUntil = clean.map(() => 0);
    this.cooldownMs = opts.cooldownMs ?? RPC_COOLDOWN_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.onSwitch = opts.onSwitch;
  }

  get size(): number {
    return this.urls.length;
  }
  get index(): number {
    return this.idx;
  }
  get endpoint(): string {
    return this.urls[this.idx]!;
  }
  label(i = this.idx): string {
    return rpcLabel(i);
  }

  markBad(index: number, reason: string): void {
    this.coolUntil[index] = this.now() + this.cooldownMs;
    log("rpc", `${rpcLabel(index)} cooldown ${Math.round(this.cooldownMs / 1000)}s (${reason})`, "warn");
  }

  pick(start = this.idx): number {
    const n = this.urls.length;
    const t = this.now();
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (this.coolUntil[i]! <= t) return i;
    }
    let best = start % n;
    for (let i = 0; i < n; i++) if (this.coolUntil[i]! < this.coolUntil[best]!) best = i;
    return best;
  }

  switchTo(to: number, reason: string): void {
    const from = this.idx;
    if (to === from) return;
    this.idx = to;
    this.onSwitch?.(from, to, reason);
    log("rpc", `${rpcLabel(from)} → ${rpcLabel(to)} (${reason})`, "warn");
  }

  /** Replace the Connection endpoint host in a request URL with `url`. Never throws on bad input. */
  rewriteUrl(input: Parameters<typeof fetch>[0] | null | undefined, url: string): string {
    if (!isValidRpcUrl(url)) {
      const fb = this.urls[0];
      if (!fb) throw new Error("RpcFailover: no valid RPC URL");
      return fb;
    }
    let raw = "";
    try {
      if (typeof input === "string") raw = input;
      else if (input instanceof URL) raw = input.toString();
      else if (input && typeof (input as Request).url === "string") raw = (input as Request).url;
    } catch {
      raw = "";
    }
    if (!raw || raw === "undefined" || raw === "null") return url;
    try {
      const src = new URL(raw);
      const dst = new URL(url);
      const out = new URL(dst.origin + (src.pathname || "/"));
      dst.searchParams.forEach((v, k) => out.searchParams.set(k, v));
      src.searchParams.forEach((v, k) => {
        if (!out.searchParams.has(k)) out.searchParams.set(k, v);
      });
      return out.toString();
    } catch {
      return url;
    }
  }

  async fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    const n = this.urls.length;
    let lastErr: unknown;
    let start = this.pick(this.idx);
    if (start !== this.idx) this.switchTo(start, "skip cooldown");

    for (let attempt = 0; attempt < n; attempt++) {
      const i = this.pick(this.idx);
      if (i !== this.idx) this.switchTo(i, "skip cooldown");
      const target = this.urls[i];
      if (!isValidRpcUrl(target)) {
        lastErr = new Error("invalid RPC slot");
        continue;
      }
      const url = this.rewriteUrl(input, target);
      if (!isValidRpcUrl(url)) {
        lastErr = new Error("rewritten RPC URL invalid");
        continue;
      }
      try {
        const res = await this.fetchFn(url, init);
        if (!isFailoverHttpStatus(res.status)) {
          this.idx = i;
          return res;
        }
        const reason = `HTTP ${res.status}`;
        this.markBad(i, reason);
        lastErr = new Error(reason);
        const next = this.pick(i + 1);
        if (next === i) break;
        this.switchTo(next, reason);
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        lastErr = e;
        if (!isFailoverErrorMessage(msg) && attempt === 0 && n === 1) throw e;
        this.markBad(i, msg.slice(0, 80));
        const next = this.pick(i + 1);
        if (next === i) break;
        this.switchTo(next, msg.slice(0, 40));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "all RPCs failed"));
  }
}

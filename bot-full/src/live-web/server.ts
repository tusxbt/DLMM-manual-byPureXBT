import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLiveSession, mintLiveToken, pruneSessions } from "./tokens.js";
import { subscribe, setLiveSnapshotFetcher, type SnapshotFetcher } from "./hub.js";
import { buildDemoSnapshot } from "./demo-sim.js";
import type { LiveSnapshot } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function resolvePublicDir(): string {
  const candidates = [
    path.join(__dirname, "public"),
    path.join(process.cwd(), "src/live-web/public"),
    path.join(process.cwd(), "dist/live-web/public"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return candidates[0];
}
const PUBLIC = resolvePublicDir();

export type LiveWebConfig = {
  enabled: boolean;
  host: string;
  port: number;
  publicBaseUrl: string;
};

export function readLiveWebConfig(env: NodeJS.ProcessEnv = process.env): LiveWebConfig {
  const enabled = String(env.LIVE_WEB_ENABLED ?? "false").toLowerCase() === "true";
  const host = env.LIVE_WEB_HOST || "127.0.0.1";
  const port = Number(env.LIVE_WEB_PORT || 8788);
  const publicBaseUrl = (env.LIVE_WEB_PUBLIC_URL || `http://${host}:${port}`).replace(/\/$/, "");
  return { enabled, host, port, publicBaseUrl };
}

let server: http.Server | null = null;
let cfg: LiveWebConfig | null = null;

export function isLiveWebRunning(): boolean {
  return !!server;
}

export function getLiveWebConfig(): LiveWebConfig | null {
  return cfg;
}

export function setLiveFetcher(fn: SnapshotFetcher | null): void {
  setLiveSnapshotFetcher(fn);
}

/** Create a short-lived read-only view URL (never embeds secret keys). */
export function createLiveViewUrl(opts: {
  demo?: boolean;
  position?: string;
  pool?: string;
  pair?: string;
  strategy?: string;
  ownerUserId?: string;
  isOwner?: boolean;
  ownerWallet?: string;
  currency?: LiveSnapshot["currency"];
}): string | null {
  if (!cfg?.enabled || !server) return null;
  const session = mintLiveToken({
    demo: !!opts.demo || !opts.position,
    position: opts.position,
    pool: opts.pool,
    pair: opts.pair,
    strategy: opts.strategy,
    ownerUserId: opts.ownerUserId,
    isOwner: opts.isOwner,
    ownerWallet: opts.ownerWallet,
    currency: opts.currency ?? "USD",
  });
  return `${cfg.publicBaseUrl}/v/${session.token}`;
}

export function createDemoLiveViewUrl(currency: LiveSnapshot["currency"] = "USD"): string | null {
  return createLiveViewUrl({ demo: true, currency });
}

function mime(p: string): string {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function send(res: http.ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function serveStatic(res: http.ServerResponse, rel: string): void {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC, safe);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    send(res, 404, "not found");
    return;
  }
  send(res, 200, fs.readFileSync(full, "utf8"), mime(full));
}

export async function startLiveWebServer(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<LiveWebConfig>
): Promise<LiveWebConfig | null> {
  if (server) return cfg;
  const base = readLiveWebConfig(env);
  cfg = { ...base, ...overrides };
  if (!cfg.enabled) {
    cfg = null;
    return null;
  }

  server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;

    if (pathname === "/health") {
      send(res, 200, JSON.stringify({ ok: true, liveWeb: true }), "application/json");
      return;
    }

    // demo landing (no token) — always marked DEMO
    if (pathname === "/" || pathname === "/demo") {
      serveStatic(res, "index.html");
      return;
    }
    if (pathname === "/app.js" || pathname === "/style.css") {
      serveStatic(res, pathname.slice(1));
      return;
    }

    // /v/:token page
    const view = pathname.match(/^\/v\/([A-Za-z0-9_-]+)$/);
    if (view) {
      const token = view[1];
      if (!getLiveSession(token)) {
        // auto-mint demo if unknown? No — 404 for security
        send(res, 404, "Session expired or invalid. Open Live Bins again from Telegram.");
        return;
      }
      serveStatic(res, "index.html");
      return;
    }

    // SSE stream
    const stream = pathname.match(/^\/api\/stream\/([A-Za-z0-9_-]+)$/);
    if (stream) {
      const token = stream[1];
      const session = getLiveSession(token);
      if (!session) {
        send(res, 404, JSON.stringify({ error: "invalid_token" }), "application/json");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": ok\n\n");
      const unsub = subscribe(token, {
        token,
        write: (c) => res.write(c),
        close: () => {
          try {
            res.end();
          } catch {
            /* */
          }
        },
      });
      req.on("close", () => unsub());
      return;
    }

    // JSON snapshot (polling fallback)
    const snap = pathname.match(/^\/api\/snapshot\/([A-Za-z0-9_-]+)$/);
    if (snap) {
      const token = snap[1];
      const session = getLiveSession(token);
      if (!session) {
        send(res, 404, JSON.stringify({ error: "invalid_token" }), "application/json");
        return;
      }
      if (session.demo) {
        send(res, 200, JSON.stringify(buildDemoSnapshot({ currency: session.currency })), "application/json");
        return;
      }
      // real: last known via hub would need export; for now return minimal placeholder until fetcher fills SSE
      send(
        res,
        200,
        JSON.stringify({
          demo: false,
          ts: new Date().toISOString(),
          pair: "…",
          strategy: "…",
          positionShort: (session.position || "").slice(0, 4) + "…" + (session.position || "").slice(-4),
          poolShort: (session.pool || "").slice(0, 4) + "…" + (session.pool || "").slice(-4),
          activeBinId: 0,
          activePrice: 0,
          minBinId: 0,
          maxBinId: 0,
          minPrice: 0,
          maxPrice: 0,
          inRange: true,
          bins: [],
          pnlUsd: null,
          feesUsd: null,
          capitalUsd: null,
          valueUsd: null,
          currency: session.currency,
          pnlText: "—",
          feesText: "—",
          valueText: "—",
          capitalText: "—",
        } satisfies LiveSnapshot),
        "application/json"
      );
      return;
    }

    // mint demo token (local only)
    if (pathname === "/api/demo-token" && req.method === "POST") {
      const s = mintLiveToken({ demo: true, currency: "USD" });
      send(res, 200, JSON.stringify({ token: s.token, url: `${cfg!.publicBaseUrl}/v/${s.token}` }), "application/json");
      return;
    }

    send(res, 404, "not found");
  });

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(cfg!.port, cfg!.host, () => resolve());
  });

  const pruneIv = setInterval(() => pruneSessions(), 60_000);
  server.on("close", () => clearInterval(pruneIv));

  return cfg;
}

export async function stopLiveWebServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  cfg = null;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

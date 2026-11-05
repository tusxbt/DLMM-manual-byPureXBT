/** Optional read-only GET /scan/latest. Off unless SCAN_HTTP_TOKEN is set; requires Bearer token. */
import http from "node:http";
import crypto from "node:crypto";
import { readLatest } from "./scanner.js";

export function authOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header || "");
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function scanHandler(token: string, read = () => readLatest()) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET" || (req.url || "").split("?")[0] !== "/scan/latest") return send(404, { error: "not found" });
    if (!authOk(req.headers.authorization, token)) return send(401, { error: "unauthorized" });
    const r = read();
    return r ? send(200, r) : send(404, { error: "no scan yet" });
  };
}

export function startScanHttp(env: NodeJS.ProcessEnv = process.env): http.Server | null {
  const token = env.SCAN_HTTP_TOKEN?.trim();
  if (!token) return null;
  const port = Number(env.SCAN_HTTP_PORT || 8787);
  const host = env.SCAN_HTTP_HOST || "127.0.0.1";
  const srv = http.createServer(scanHandler(token));
  srv.listen(port, host);
  return srv;
}

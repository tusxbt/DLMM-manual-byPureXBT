import crypto from "node:crypto";
import type { LiveSessionInfo, LiveSnapshot } from "./types.js";

const sessions = new Map<string, LiveSessionInfo>();

/** Opaque URL token — not a wallet key. */
export function mintLiveToken(partial: Omit<LiveSessionInfo, "token" | "createdAt" | "lastSeenAt">): LiveSessionInfo {
  const token = crypto.randomBytes(24).toString("base64url");
  const s: LiveSessionInfo = {
    ...partial,
    token,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  sessions.set(token, s);
  return s;
}

export function getLiveSession(token: string): LiveSessionInfo | null {
  const s = sessions.get(token);
  if (!s) return null;
  s.lastSeenAt = Date.now();
  return s;
}

export function touchSession(token: string): void {
  const s = sessions.get(token);
  if (s) s.lastSeenAt = Date.now();
}

/** Drop sessions idle > TTL (default 30 min). */
export function pruneSessions(ttlMs = 30 * 60_000, now = Date.now()): number {
  let n = 0;
  for (const [k, s] of sessions) {
    if (now - s.lastSeenAt > ttlMs) {
      sessions.delete(k);
      n++;
    }
  }
  return n;
}

export function listActiveRealSessions(): LiveSessionInfo[] {
  return [...sessions.values()].filter((s) => !s.demo && s.position && s.pool);
}

export function resetLiveSessionsForTests(): void {
  sessions.clear();
}

export type { LiveSessionInfo, LiveSnapshot };

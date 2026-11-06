import type { LiveSnapshot } from "./types.js";
import { buildDemoSnapshot } from "./demo-sim.js";
import { getLiveSession, listActiveRealSessions, touchSession } from "./tokens.js";

export type SnapshotFetcher = (args: {
  position: string;
  pool: string;
  currency: LiveSnapshot["currency"];
  pair?: string;
  strategy?: string;
  ownerUserId?: string;
  isOwner?: boolean;
  ownerWallet?: string;
}) => Promise<LiveSnapshot | null>;

type Client = {
  token: string;
  write: (chunk: string) => void;
  close: () => void;
};

const clients = new Map<string, Set<Client>>(); // token -> clients
let pollTimer: ReturnType<typeof setInterval> | null = null;
let fetcher: SnapshotFetcher | null = null;
const lastSnap = new Map<string, LiveSnapshot>();
const POLL_MS = 1500;

export function setLiveSnapshotFetcher(fn: SnapshotFetcher | null): void {
  fetcher = fn;
}

export function subscribe(token: string, client: Client): () => void {
  let set = clients.get(token);
  if (!set) {
    set = new Set();
    clients.set(token, set);
  }
  set.add(client);
  touchSession(token);
  // push cached or immediate demo
  const s = getLiveSession(token);
  if (s?.demo) {
    const snap = buildDemoSnapshot({ currency: s.currency });
    lastSnap.set(token, snap);
    pushOne(client, snap);
  } else if (lastSnap.has(token)) {
    pushOne(client, lastSnap.get(token)!);
  }
  ensurePoll();
  return () => {
    set!.delete(client);
    if (set!.size === 0) clients.delete(token);
    if (clients.size === 0) stopPoll();
  };
}

function pushOne(c: Client, snap: LiveSnapshot): void {
  try {
    c.write(`data: ${JSON.stringify(snap)}\n\n`);
  } catch {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
}

function broadcast(token: string, snap: LiveSnapshot): void {
  lastSnap.set(token, snap);
  const set = clients.get(token);
  if (!set) return;
  for (const c of [...set]) pushOne(c, snap);
}

function ensurePoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void tick();
  }, POLL_MS);
}

function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function tick(): Promise<void> {
  // Demo sessions: refresh every tick from sim
  for (const token of clients.keys()) {
    const s = getLiveSession(token);
    if (!s) continue;
    if (s.demo) {
      broadcast(token, buildDemoSnapshot({ currency: s.currency }));
      continue;
    }
  }
  // Real: only positions that currently have at least one subscriber
  if (!fetcher) return;
  const open = listActiveRealSessions().filter((s) => (clients.get(s.token)?.size ?? 0) > 0);
  await Promise.all(
    open.map(async (s) => {
      try {
        const snap = await fetcher!({
          position: s.position!,
          pool: s.pool!,
          currency: s.currency,
          pair: s.pair,
          strategy: s.strategy,
          ownerUserId: s.ownerUserId,
          isOwner: s.isOwner,
          ownerWallet: s.ownerWallet,
        });
        if (snap) broadcast(s.token, { ...snap, demo: false });
      } catch {
        /* keep last */
      }
    })
  );
}

/** Test helpers */
export function __hubTestReset(): void {
  stopPoll();
  clients.clear();
  lastSnap.clear();
  fetcher = null;
}

export function __hubClientCount(): number {
  let n = 0;
  for (const s of clients.values()) n += s.size;
  return n;
}

export { POLL_MS };

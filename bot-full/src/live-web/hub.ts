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
const fetching = new Set<string>();
const POLL_MS = 2000;

export function setLiveSnapshotFetcher(fn: SnapshotFetcher | null): void {
  fetcher = fn;
}

export function getLastLiveSnapshot(token: string): LiveSnapshot | null {
  return lastSnap.get(token) ?? null;
}

export function subscribe(token: string, client: Client): () => void {
  let set = clients.get(token);
  if (!set) {
    set = new Set();
    clients.set(token, set);
  }
  set.add(client);
  touchSession(token);
  const s = getLiveSession(token);
  if (s?.demo) {
    const snap = buildDemoSnapshot({ currency: s.currency });
    lastSnap.set(token, snap);
    pushOne(client, snap);
  } else if (lastSnap.has(token)) {
    pushOne(client, lastSnap.get(token)!);
  } else {
    // immediate kick so first paint isn't empty placeholder
    void refreshToken(token);
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

async function refreshToken(token: string): Promise<void> {
  const s = getLiveSession(token);
  if (!s) return;
  if (s.demo) {
    broadcast(token, buildDemoSnapshot({ currency: s.currency }));
    return;
  }
  if (!fetcher || !s.position || !s.pool) return;
  if (fetching.has(token)) return;
  fetching.add(token);
  try {
    const snap = await fetcher({
      position: s.position,
      pool: s.pool,
      currency: s.currency,
      pair: s.pair,
      strategy: s.strategy,
      ownerUserId: s.ownerUserId,
      isOwner: s.isOwner,
      ownerWallet: s.ownerWallet,
    });
    if (snap) broadcast(token, { ...snap, demo: false });
  } catch {
    /* keep last */
  } finally {
    fetching.delete(token);
  }
}

async function tick(): Promise<void> {
  for (const token of clients.keys()) {
    const s = getLiveSession(token);
    if (!s) continue;
    if (s.demo) {
      broadcast(token, buildDemoSnapshot({ currency: s.currency }));
      continue;
    }
  }
  if (!fetcher) return;
  const open = listActiveRealSessions().filter((s) => (clients.get(s.token)?.size ?? 0) > 0);
  // one fetch per unique position (dedupe shared viewers)
  const byPos = new Map<string, typeof open>();
  for (const s of open) {
    const k = s.position!;
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k)!.push(s);
  }
  await Promise.all(
    [...byPos.values()].map(async (group) => {
      await refreshToken(group[0]!.token);
      // copy snap to sibling tokens for same position
      const snap = lastSnap.get(group[0]!.token);
      if (!snap) return;
      for (const s of group.slice(1)) broadcast(s.token, snap);
    }),
  );
}

/** Test helpers */
export function __hubTestReset(): void {
  stopPoll();
  clients.clear();
  lastSnap.clear();
  fetching.clear();
  fetcher = null;
}

export function __hubClientCount(): number {
  let n = 0;
  for (const s of clients.values()) n += s.size;
  return n;
}

export { POLL_MS };

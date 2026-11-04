const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const current: Level = (process.env.LOG_LEVEL as Level) || "info";

/** Patterns that must never appear in logs (private keys, seeds, long base58 secrets). */
const SECRET_ENV_KEYS = [
  "WALLET_PRIVATE_KEY",
  "PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "SECRET_KEY",
  "MNEMONIC",
  "SEED_PHRASE",
  "SEED",
  "TELEGRAM_BOT_TOKEN",
];

export function redactSecrets(input: unknown): string {
  let s = typeof input === "string" ? input : stringifySafe(input);
  for (const key of SECRET_ENV_KEYS) {
    const v = process.env[key];
    if (v && v.trim().length >= 8) {
      s = s.split(v).join(`[REDACTED:${key}]`);
    }
  }
  // Long base58-looking blobs (typical Solana secret key encoding length ~64–128)
  s = s.replace(/\b[1-9A-HJ-NP-Za-km-z]{64,120}\b/g, "[REDACTED:base58]");
  // BIP39-ish word dumps (very rough)
  if (/\b(seed|mnemonic|private[_\s-]?key)\b/i.test(s)) {
    s = s.replace(/(seed|mnemonic|private[_\s-]?key)\s*[:=]\s*[^\n,;]+/gi, "$1=[REDACTED]");
  }
  return s;
}

function stringifySafe(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => {
      if (typeof val === "string") return redactSecrets(val);
      if (val && typeof val === "object") {
        const name = (val as { constructor?: { name?: string } }).constructor?.name;
        if (name === "Keypair" || name === "SecretKey") return "[REDACTED:Keypair]";
      }
      return val;
    });
  } catch {
    return String(v);
  }
}

export function log(tag: string, msg: string, level: Level = "info"): void {
  if (LEVELS[level] < LEVELS[current]) return;
  const ts = new Date().toISOString();
  const safe = redactSecrets(msg);
  const line = `${ts} [${level}] ${tag}: ${safe}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Install process-level handlers that redact secrets in unexpected errors. */
export function installRedactingErrorHandlers(): void {
  process.on("uncaughtException", (err) => {
    log("uncaught", redactSecrets(err?.stack || err?.message || err), "error");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection", redactSecrets(reason), "error");
  });
}

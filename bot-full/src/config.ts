import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getWallet, getWalletPublicKey, resetWalletForTests } from "./engine/wallet.js";
import { parseRpcUrls } from "./engine/rpc-failover.js";
import { scopedNonOwner} from "./users/context.js";
import { walletPubkeyOf } from "./users/store.js";

export type AppConfig = {
  telegramToken: string;
  telegramChatId: string;
  allowedUserIds: Set<string>;
  walletPublicKey: PublicKey;
  rpcUrl: string;
  /** Ordered RPC endpoints (RPC_URLS or [RPC_URL]). */
  rpcUrls: string[];
  heliusApiKey: string | null;
  jupiterApiKey: string | null;
  dataDir: string;
  dryRun: boolean;
  tokens: { sol: string; usdc: string };
};

let _config: AppConfig | null = null;

export function envFilePath(cwd = process.cwd()): string {
  return path.resolve(cwd, ".env");
}

/** Returns ok=false if .env missing or mode !== 0o600. */
export function checkEnvFilePermissions(envPath = envFilePath()): {
  ok: boolean;
  mode?: number;
  reason?: string;
} {
  if (!fs.existsSync(envPath)) {
    return { ok: false, reason: `.env tidak ditemukan di ${envPath}` };
  }
  const mode = fs.statSync(envPath).mode & 0o777;
  if (mode !== 0o600) {
    return {
      ok: false,
      mode,
      reason: `.env permissions harus 600 (sekarang ${mode.toString(8)}). Jalankan: chmod 600 .env`,
    };
  }
  return { ok: true, mode };
}

export function assertEnvFilePermissions(envPath = envFilePath()): void {
  if (process.env.DLMM_SKIP_ENV_CHMOD === "1") return;
  const r = checkEnvFilePermissions(envPath);
  if (!r.ok) {
    console.error(`[fatal] ${r.reason}`);
    process.exit(1);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[fatal] Missing required env: ${name} (lihat .env.example)`);
    process.exit(1);
  }
  return v;
}

export function loadConfig(opts?: { requireTelegram?: boolean; skipWallet?: boolean }): AppConfig {
  const base = loadBaseConfig(opts);
  const uid = scopedNonOwner();
  if (!uid) return base;
  // non-owner scope: own data dir + own wallet pubkey (system program placeholder if none yet)
  const pk = walletPubkeyOf(uid);
  return {
    ...base,
    dataDir: path.join(base.dataDir, "users", uid),
    walletPublicKey: new PublicKey(pk || "11111111111111111111111111111111"),
  };
}

function loadBaseConfig(opts?: { requireTelegram?: boolean; skipWallet?: boolean }): AppConfig {
  if (_config) return _config;

  const requireTelegram = opts?.requireTelegram !== false;
  const telegramToken = requireTelegram
    ? requireEnv("TELEGRAM_BOT_TOKEN")
    : process.env.TELEGRAM_BOT_TOKEN?.trim() || "test-token";
  const telegramChatId = requireTelegram
    ? requireEnv("TELEGRAM_CHAT_ID")
    : process.env.TELEGRAM_CHAT_ID?.trim() || "0";

  const allowedRaw = process.env.ALLOWED_TELEGRAM_USER_IDS?.trim() || "";
  const allowedUserIds = new Set(
    allowedRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (requireTelegram && allowedUserIds.size === 0) {
    console.error(
      "[fatal] ALLOWED_TELEGRAM_USER_IDS wajib diisi (whitelist user ID Telegram, pisahkan koma)",
    );
    process.exit(1);
  }

  const singleRpc = requireTelegram
    ? (process.env.RPC_URL?.trim() || "")
    : (process.env.RPC_URL?.trim() || "https://api.mainnet-beta.solana.com");
  if (requireTelegram && !process.env.RPC_URLS?.trim() && !singleRpc) {
    // preserve old requireEnv behaviour when neither is set
    requireEnv("RPC_URL");
  }
  const rpcUrls = parseRpcUrls(process.env.RPC_URLS, singleRpc || undefined);
  const rpcUrl = rpcUrls[0]!;

  let walletPublicKey: PublicKey;
  if (opts?.skipWallet) {
    const pub = process.env.WALLET_PUBLIC_KEY?.trim();
    walletPublicKey = pub
      ? new PublicKey(pub)
      : new PublicKey("So11111111111111111111111111111111111111112");
  } else {
    // Derive from private key — never store the secret in config
    try {
      void getWallet();
      walletPublicKey = getWalletPublicKey();
    } catch (e) {
      console.error(`[fatal] ${(e as Error).message}`);
      process.exit(1);
    }
  }

  const dryRunRaw = process.env.DRY_RUN;
  const dryRun = dryRunRaw == null || dryRunRaw.trim() === "" ? true : dryRunRaw.trim().toLowerCase() === "true";

  _config = {
    telegramToken,
    telegramChatId,
    allowedUserIds,
    walletPublicKey,
    rpcUrl,
    rpcUrls,
    heliusApiKey: process.env.HELIUS_API_KEY?.trim() || null,
    jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || null,
    dataDir: process.env.DATA_DIR?.trim() || "./data",
    dryRun,
    tokens: {
      sol: "So11111111111111111111111111111111111111112",
      usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
  };
  return _config;
}

export function resetConfigForTests(): void {
  _config = null;
  resetWalletForTests();
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const CONFIRM_TTL_MS = 60_000;

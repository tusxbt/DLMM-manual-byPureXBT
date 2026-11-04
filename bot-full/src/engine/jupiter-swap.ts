import { getMintDecimals } from "./decimals.js";
/**
 * Jupiter swap — quote + build versioned tx; wallet signs at execute time.
 */
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { loadConfig, SOL_MINT } from "../config.js";
import { getConnection } from "./connection.js";
import { getWalletPublicKey } from "./wallet.js";
import type { PendingTxItem } from "./pending.js";
import { log } from "../logger.js";
import { jupiterSlippageBps } from "./slippage.js";
import { jupiterPrioritization } from "./priority.js";

/** quote-api.jup.ag/v6 is gone (DNS fail). Swap API v1: api.jup.ag (with key) or lite-api.jup.ag. */
function swapBase(): string {
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  return cfg.jupiterApiKey ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
}

export function normalizeMint(mint: string): string {
  if (!mint) return mint;
  if (mint === "SOL" || mint === "native") return SOL_MINT;
  return mint;
}

export type SwapQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  raw: unknown;
};

export async function getSwapQuote(input: {
  inputMint: string;
  outputMint: string;
  amountAtomic: string;
  slippageBps?: number;
}): Promise<SwapQuote> {
  const inputMint = normalizeMint(input.inputMint);
  const outputMint = normalizeMint(input.outputMint);
  const slippageBps = input.slippageBps ?? jupiterSlippageBps();
  const url =
    `${swapBase()}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${input.amountAtomic}&slippageBps=${slippageBps}`;
  const headers: Record<string, string> = { accept: "application/json" };
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  if (cfg.jupiterApiKey) headers["x-api-key"] = cfg.jupiterApiKey;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Jupiter quote HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = await res.json();
  if (!raw?.outAmount) throw new Error(`Jupiter quote invalid: ${JSON.stringify(raw).slice(0, 200)}`);
  return {
    inputMint,
    outputMint,
    inAmount: String(raw.inAmount),
    outAmount: String(raw.outAmount),
    otherAmountThreshold: String(raw.otherAmountThreshold || raw.outAmount),
    raw,
  };
}

export async function buildSwapTx(input: {
  quote: SwapQuote;
  wrapAndUnwrapSol?: boolean;
}): Promise<PendingTxItem> {
  const userPublicKey = getWalletPublicKey().toBase58();
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (cfg.jupiterApiKey) headers["x-api-key"] = cfg.jupiterApiKey;

  const body = {
    quoteResponse: input.quote.raw,
    userPublicKey,
    wrapAndUnwrapSol: input.wrapAndUnwrapSol !== false,
    dynamicComputeUnitLimit: true,
    ...(jupiterPrioritization() ? { prioritizationFeeLamports: jupiterPrioritization() } : {}),
  };
  const res = await fetch(`${swapBase()}/swap`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Jupiter swap HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const swapTransaction = data.swapTransaction as string | undefined;
  if (!swapTransaction) throw new Error("Jupiter tidak mengembalikan swapTransaction");

  // Sanity deserialize — do not sign here
  VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  void getConnection;

  log("swap_build", `swap ${input.quote.inputMint.slice(0, 6)}→${input.quote.outputMint.slice(0, 6)}`);
  return {
    serialized: swapTransaction,
    encoding: "versioned",
    label: "jupiterSwap",
  };
}

/** @deprecated alias */
export const buildUnsignedSwapTx = buildSwapTx;

export async function uiAmountToAtomic(mint: string, uiAmount: number): Promise<string> {
  mint = normalizeMint(mint);
  if (mint === SOL_MINT) return String(Math.floor(uiAmount * 1e9));
  const dec = await getMintDecimals(mint);
  return String(Math.floor(uiAmount * 10 ** dec));
}

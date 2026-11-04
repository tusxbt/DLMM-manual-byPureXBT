/**
 * Realized PnL from the close txs themselves — NOT from wallet SOL balance delta.
 *
 * Per landed tx (wallet = fee payer / owner):
 *   walletSolNet  = (walletPost − walletPre) + txFee                    // tx fee excluded
 *   rentFlow      = Σ closed non-wallet accts (pre − wrapped)            // position / ATA rent refunds
 *                 − Σ created non-wallet accts (post − wrapped)          // rent paid for new ATAs
 *   wrappedSolNet = Σ wallet-owned wSOL token deltas                     // SOL still wrapped
 *   solNet        = walletSolNet − rentFlow + wrappedSolNet
 *   tokenNet[m]   = Σ wallet-owned token deltas for mint m (≠ wSOL)
 *
 * Realized USD = solNet·SOL_USD + Σ tokenNet[m]·price[m] − depositUsd
 * (zapout: token already swapped, so solNet includes the swap output.)
 */
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection.js";
import { SOL_MINT } from "../config.js";
import { log } from "../logger.js";

export type TokBal = { i: number; mint: string; owner?: string; amount: string; decimals: number };
export type TxFlow = {
  keys: string[];
  pre: number[];
  post: number[];
  fee: number;
  feePayer: string;
  preTok: TokBal[];
  postTok: TokBal[];
};

export type Realized = { solNet: number; tokenNet: Record<string, number>; rentSol: number; feeSol: number };

const LAMPORTS = 1e9;

export function realizedFromFlows(flows: TxFlow[], wallet: string): Realized {
  let solLamports = 0;
  let rentLamports = 0;
  let feeLamports = 0;
  const tokenAtomic: Record<string, { amt: bigint; dec: number }> = {};
  for (const f of flows) {
    const wi = f.keys.indexOf(wallet);
    if (wi < 0) continue;
    const fee = f.feePayer === wallet ? f.fee : 0;
    feeLamports += fee;
    solLamports += f.post[wi] - f.pre[wi] + fee;
    // wrapped SOL inside each token account (atomic = lamports)
    const wrapped = (list: TokBal[], i: number) => {
      const t = list.find((x) => x.i === i && x.mint === SOL_MINT);
      return t ? Number(t.amount) : 0;
    };
    for (let i = 0; i < f.keys.length; i++) {
      if (i === wi) continue;
      if (f.pre[i] > 0 && f.post[i] === 0) rentLamports += f.pre[i] - wrapped(f.preTok, i);
      else if (f.pre[i] === 0 && f.post[i] > 0) rentLamports -= f.post[i] - wrapped(f.postTok, i);
    }
    // wallet-owned token deltas
    const idx = new Set([...f.preTok, ...f.postTok].filter((t) => t.owner === wallet).map((t) => `${t.i}|${t.mint}`));
    for (const k of idx) {
      const [iStr, mint] = k.split("|");
      const i = Number(iStr);
      const a = f.preTok.find((t) => t.i === i && t.mint === mint);
      const b = f.postTok.find((t) => t.i === i && t.mint === mint);
      const dec = (a ?? b)!.decimals;
      const d = BigInt(b?.amount ?? "0") - BigInt(a?.amount ?? "0");
      if (mint === SOL_MINT) solLamports += Number(d);
      else {
        tokenAtomic[mint] ??= { amt: 0n, dec };
        tokenAtomic[mint].amt += d;
      }
    }
  }
  const tokenNet: Record<string, number> = {};
  for (const [m, v] of Object.entries(tokenAtomic)) if (v.amt !== 0n) tokenNet[m] = Number(v.amt) / 10 ** v.dec;
  return {
    solNet: (solLamports - rentLamports) / LAMPORTS,
    tokenNet,
    rentSol: rentLamports / LAMPORTS,
    feeSol: feeLamports / LAMPORTS,
  };
}

export function realizedUsd(r: Realized, solUsd: number | null, prices: Record<string, number | null | undefined>, depositUsd: number | null): {
  exitUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
} {
  if (solUsd == null) return { exitUsd: null, pnlUsd: null, pnlPct: null };
  let exit = r.solNet * solUsd;
  for (const [m, amt] of Object.entries(r.tokenNet)) {
    const p = prices[m];
    if (p == null) return { exitUsd: null, pnlUsd: null, pnlPct: null }; // unknown token price → don't guess
    exit += amt * p;
  }
  if (depositUsd == null || !(depositUsd > 0)) return { exitUsd: exit, pnlUsd: null, pnlPct: null };
  const pnl = exit - depositUsd;
  return { exitUsd: exit, pnlUsd: pnl, pnlPct: (pnl / depositUsd) * 100 };
}

/** Fetch landed txs (parsed) and convert to flows. Missing txs are skipped (logged). */
export async function fetchFlows(signatures: string[]): Promise<TxFlow[]> {
  const conn = getConnection();
  const out: TxFlow[] = [];
  await Promise.all(
    signatures.map(async (sig) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
          if (tx?.meta) {
            const keys = tx.transaction.message.accountKeys.map((k) => (k.pubkey instanceof PublicKey ? k.pubkey.toBase58() : String(k.pubkey)));
            const tb = (l: typeof tx.meta.preTokenBalances): TokBal[] =>
              (l || []).map((t) => ({ i: t.accountIndex, mint: t.mint, owner: t.owner, amount: t.uiTokenAmount.amount, decimals: t.uiTokenAmount.decimals }));
            out.push({ keys, pre: tx.meta.preBalances, post: tx.meta.postBalances, fee: tx.meta.fee, feePayer: keys[0], preTok: tb(tx.meta.preTokenBalances), postTok: tb(tx.meta.postTokenBalances) });
            return;
          }
        } catch (e) {
          log("realized", `getParsedTransaction ${sig.slice(0, 8)}: ${(e as Error).message}`, "warn");
        }
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }),
  );
  return out;
}

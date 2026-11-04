/** Pre-deploy SOL sufficiency: amount + position rent + new bin-array rent + tx fee buffer. */
export const FEE_BUFFER_BASE_SOL = 0.01; // tx fees + ATA/wrap overhead
export const FEE_BUFFER_PER_TX_SOL = 0.002; // priority fee headroom per tx

export type FundsCheck = { needSol: number; haveSol: number; feeBufferSol: number; shortSol: number; ok: boolean };

export function checkFunds(i: {
  haveSol: number | null | undefined;
  amountSol: number;
  positionRentSol?: number | null;
  binArrayRentSol?: number | null;
  txCount?: number;
}): FundsCheck {
  const fin = (x: number | null | undefined) => (x != null && Number.isFinite(x) ? x : 0);
  const feeBufferSol = FEE_BUFFER_BASE_SOL + FEE_BUFFER_PER_TX_SOL * Math.max(1, i.txCount ?? 1);
  const needSol = fin(i.amountSol) + fin(i.positionRentSol) + fin(i.binArrayRentSol) + feeBufferSol;
  const haveSol = fin(i.haveSol);
  const shortSol = Math.max(0, needSol - haveSol);
  return { needSol, haveSol, feeBufferSol, shortSol, ok: shortSol <= 0 };
}

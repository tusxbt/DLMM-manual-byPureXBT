export { fmtMoney, fmtMoneyShort, currentDisplayCurrency } from "./display-money.js";
export function fmtNum(n: number | null | undefined, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "$—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function shortAddr(a: string | null | undefined, n = 4): string {
  if (!a) return "—";
  if (a.length <= n * 2 + 3) return a;
  return `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

export function solscanAccount(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}

export function strategyLabel(s: string): string {
  const m: Record<string, string> = {
    spot: "Spot",
    bid_ask: "Bid-Ask",
    curve: "Curve",
    mix: "Mix",
    Spot: "Spot",
    BidAsk: "Bid-Ask",
    Curve: "Curve",
  };
  return m[s] || s;
}

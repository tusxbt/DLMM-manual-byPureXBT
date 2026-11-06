/** Read-only live bins snapshot for the mini web viewer. */

export type LiveBinBar = {
  binId: number;
  /** 0–1 relative liquidity height */
  height: number;
};

export type LiveSnapshot = {
  demo: boolean;
  ts: string;
  pair: string;
  strategy: string;
  positionShort: string;
  poolShort: string;
  activeBinId: number;
  activePrice: number;
  minBinId: number;
  maxBinId: number;
  minPrice: number;
  maxPrice: number;
  inRange: boolean;
  bins: LiveBinBar[];
  pnlUsd: number | null;
  feesUsd: number | null;
  capitalUsd: number | null;
  valueUsd: number | null;
  currency: "USD" | "IDR" | "SOL";
  /** display-ready strings from server (already converted) */
  pnlText: string;
  feesText: string;
  valueText: string;
  capitalText: string;
};

export type LiveSessionInfo = {
  token: string;
  demo: boolean;
  position?: string;
  pool?: string;
  /** From store / PositionCard at mint time */
  pair?: string;
  strategy?: string;
  /** Telegram user who minted — hub re-enters their wallet scope for polls */
  ownerUserId?: string;
  isOwner?: boolean;
  /** Wallet pubkey that owned the position at mint (read-only check) */
  ownerWallet?: string;
  currency: LiveSnapshot["currency"];
  createdAt: number;
  lastSeenAt: number;
};

/** Pluggable DLMM liquidity distribution strategies. */

export type StrategyId = string;

export type StrategySide = "one_sided_sol" | "two_sided";

export type RangePreset = {
  id: string;
  label: string;
  /** Percent downside from active price (bins derived later). */
  downPct: number;
  /** Percent upside from active price. */
  upPct: number;
};

export type StrategyDefinition = {
  id: StrategyId;
  /** Telegram button label */
  label: string;
  description: string;
  /** Maps to @meteora-ag/dlmm StrategyType enum key */
  meteoraKey: "Spot" | "Curve" | "BidAsk";
  defaultSide: StrategySide;
  rangePresets: RangePreset[];
};

export type ResolvedRange = {
  binsBelow: number;
  binsAbove: number;
  downPct: number | null;
  upPct: number | null;
  mode: "preset_pct" | "custom_bins" | "custom_price";
};

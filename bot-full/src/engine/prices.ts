import { log } from "../logger.js";
import { SOL_MINT } from "../config.js";

const JUP_PRICE = "https://api.jup.ag/price/v2";

export async function getUsdPrices(mints: string[]): Promise<Record<string, number>> {
  const unique = [...new Set(mints.filter(Boolean))];
  if (!unique.length) return {};
  try {
    const url = `${JUP_PRICE}?ids=${unique.join(",")}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Record<string, { price?: string | number }> };
    const out: Record<string, number> = {};
    for (const [mint, row] of Object.entries(data.data || {})) {
      const p = Number(row?.price);
      if (Number.isFinite(p)) out[mint] = p;
    }
    return out;
  } catch (e) {
    log("prices", `Jupiter price failed: ${(e as Error).message}`, "warn");
    return {};
  }
}

export async function getSolUsd(): Promise<number> {
  const p = await getUsdPrices([SOL_MINT]);
  return p[SOL_MINT] ?? 0;
}

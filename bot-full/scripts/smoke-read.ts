/**
 * Read-only smoke: search pools (network). No keys, no txs.
 */
import { searchPools } from "../src/engine/dlmm-read.js";

const q = process.argv[2] || "SOL";
const pools = await searchPools(q, 3);
console.log(JSON.stringify(pools, null, 2));

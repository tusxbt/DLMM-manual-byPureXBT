import { runScan, scanFile } from "../src/scan/scanner.js";
import { scanText } from "../src/scan/format.js";
const r = await runScan();
console.log(scanText(r, 15).replace(/\*\*|`/g, ""));
console.log(`\nsaved → ${scanFile()}`);

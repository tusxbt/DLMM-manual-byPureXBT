/**
 * Standalone DEMO Live Bins server — no Telegram, no wallet, no chain.
 *   npm run live-demo
 * Then open the printed URL (badge DEMO).
 */
import {
  startLiveWebServer,
  createDemoLiveViewUrl,
  stopLiveWebServer,
} from "../src/live-web/index.js";

process.env.LIVE_WEB_ENABLED = process.env.LIVE_WEB_ENABLED || "true";
process.env.LIVE_WEB_HOST = process.env.LIVE_WEB_HOST || "127.0.0.1";
process.env.LIVE_WEB_PORT = process.env.LIVE_WEB_PORT || "8788";

const cfg = await startLiveWebServer();
if (!cfg) {
  console.error("Failed to start (LIVE_WEB_ENABLED?)");
  process.exit(1);
}
const url = createDemoLiveViewUrl("USD");
console.log("");
console.log("◆ Live Bins DEMO (read-only, simulated bins/PnL/fees)");
console.log(`  ${url}`);
console.log(`  or ${cfg.publicBaseUrl}/demo`);
console.log("  Ctrl+C to stop. Do not expose publicly.");
console.log("");

process.on("SIGINT", async () => {
  await stopLiveWebServer();
  process.exit(0);
});

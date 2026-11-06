import { assertEnvFilePermissions, loadConfig } from "./config.js";
import { installRedactingErrorHandlers, log } from "./logger.js";
import { createBot } from "./telegram/bot.js";
import { BOT_COMMANDS } from "./telegram/panels.js";

installRedactingErrorHandlers();
assertEnvFilePermissions();
const cfg = loadConfig();

log(
  "boot",
  `wallet=${cfg.walletPublicKey.toBase58()} dryRun=${cfg.dryRun}`,
);
log(
  "boot",
  "WARNING: bot menandatangani dengan WALLET_PRIVATE_KEY dari .env — pakai wallet TERPISAH dana kecil saja",
);

import { startTpslMonitor } from "./telegram/tpsl-ui.js";
import { startScanHttp } from "./scan/http.js";
import { runAutoZapout } from "./telegram/bot.js";
import { startLiveWebServer, setLiveFetcher, stopLiveWebServer } from "./live-web/index.js";
import { fetchLiveSnapshot } from "./live-web/snapshot.js";
const bot = createBot();
if (startScanHttp()) log("scan", "GET /scan/latest aktif (Bearer SCAN_HTTP_TOKEN)");
void startLiveWebServer().then((liveCfg) => {
  if (!liveCfg) return;
  setLiveFetcher(fetchLiveSnapshot);
  log("live-web", `read-only viewer on ${liveCfg.publicBaseUrl} (DEMO+/v/:token)`);
});
startTpslMonitor(bot, runAutoZapout); // 15s loop only while some TP/SL exists; auto zapout only when toggled ON

bot.api
  .setMyCommands(BOT_COMMANDS)
  .then(() => log("telegram", `setMyCommands OK (${BOT_COMMANDS.length})`))
  .catch((e) => log("telegram", `setMyCommands gagal: ${(e as Error).message}`, "warn"));

bot.start({
  onStart: (info) => log("telegram", `grammY @${info.username} polling`),
});

process.on("SIGINT", () => {
  log("boot", "shutting down");
  void stopLiveWebServer();
  bot.stop();
  process.exit(0);
});

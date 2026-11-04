import { assertEnvFilePermissions, loadConfig } from "./config.js";
import { installRedactingErrorHandlers, log } from "./logger.js";
import { createBot } from "./telegram/bot.js";

installRedactingErrorHandlers();
assertEnvFilePermissions();
const cfg = loadConfig();

log(
  "boot",
  `wallet=${cfg.walletPublicKey.toBase58()} dryRun=${cfg.dryRun} maxPos=${cfg.maxPositionUsd} maxSwap=${cfg.maxSwapUsd}`,
);
log(
  "boot",
  "WARNING: bot menandatangani dengan WALLET_PRIVATE_KEY dari .env — pakai wallet TERPISAH dana kecil saja",
);

const bot = createBot();

bot.start({
  onStart: (info) => log("telegram", `grammY @${info.username} polling`),
});

process.on("SIGINT", () => {
  log("boot", "shutting down");
  bot.stop();
  process.exit(0);
});

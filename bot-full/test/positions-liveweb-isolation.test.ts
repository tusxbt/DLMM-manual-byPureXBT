import test from "node:test";
import assert from "node:assert/strict";
import { mintLiveUrlForCard, renderWebLiveMenu } from "../src/telegram/positions-view.js";
import { isValidRpcUrl, parseRpcUrls } from "../src/engine/rpc-failover.js";

test("mintLiveUrlForCard returns null when live-web off (does not throw)", () => {
  assert.equal(mintLiveUrlForCard({
    position: "7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg",
    pool: "Pool2222222222222222222222222222222222222222",
    pair: "BONK/SOL",
  }), null);
});

test("renderWebLiveMenu empty positions stays usable", () => {
  const m = renderWebLiveMenu([]);
  assert.match(m.text, /Belum ada posisi/);
});

test("config URL helpers never accept undefined literal", () => {
  assert.equal(isValidRpcUrl("undefined"), false);
  assert.ok(parseRpcUrls("undefined", "undefined")[0]!.includes("mainnet-beta"));
});

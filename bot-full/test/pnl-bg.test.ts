import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { createCanvas } from "@napi-rs/canvas";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-"));
process.env.DATA_DIR = dir;
process.env.ALLOWED_TELEGRAM_USER_IDS = "111";
process.env.TELEGRAM_CHAT_ID = "111";
process.env.WALLET_PRIVATE_KEY ||= bs58.encode(Keypair.generate().secretKey);
delete process.env.PNL_BG_PATH;
const { runAsUser } = await import("../src/users/context.js");
const bg = await import("../src/telegram/pnl-bg.js");
const { renderPnlCard, preloadPnlBackground } = await import("../src/render/pnl-card.js");

const png = (w: number, h: number) => {
  const c = createCanvas(w, h);
  const x = c.getContext("2d");
  x.fillStyle = "#3355ff";
  x.fillRect(0, 0, w, h);
  return c.toBuffer("image/png");
};

test("process: cover-crop to 1200x800 JPEG; rejects non-image/too big/too small", async () => {
  const out = await bg.processBgImage(png(1600, 900), "image/png");
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
  const { loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(out);
  assert.equal(img.width, 1200);
  assert.equal(img.height, 800);
  await assert.rejects(bg.processBgImage(Buffer.from("hello world, not an image"), "image/png"), /Bukan gambar/);
  await assert.rejects(bg.processBgImage(png(100, 100)), /terlalu kecil/);
  await assert.rejects(bg.processBgImage(Buffer.alloc(bg.BG_MAX_BYTES + 1)), /maks 10MB/);
  await assert.rejects(bg.processBgImage(png(400, 400), "application/pdf"), /JPG\/PNG/);
});

test("per-user isolation (owner too) + reset + fallback env", async () => {
  const jpg = await bg.processBgImage(png(1300, 900));
  runAsUser({ userId: "111", isOwner: true }, () => bg.saveUserBg(jpg));
  assert.ok(fs.existsSync(path.join(dir, "users", "111", "pnl-bg.jpg")));
  runAsUser({ userId: "222", isOwner: false }, () => {
    assert.equal(bg.bgForCurrentUser().custom, false);
    assert.equal(bg.bgForCurrentUser().background, null);
  });
  runAsUser({ userId: "111", isOwner: true }, () => {
    const b = bg.bgForCurrentUser();
    assert.equal(b.custom, true);
    assert.match(String(b.background), /users\/111\/pnl-bg\.jpg$/);
    assert.equal(bg.resetUserBg(), true);
    assert.equal(bg.bgForCurrentUser().custom, false);
  });
  process.env.PNL_BG_PATH = "/x/global.jpg";
  runAsUser({ userId: "222", isOwner: false }, () => assert.equal(bg.bgForCurrentUser().background, "/x/global.jpg"));
  delete process.env.PNL_BG_PATH;
  assert.equal(bg.userBgPath("../etc"), null);
});

test("card renders with custom bg, darkness + blur, STATUS label", async () => {
  const f = path.join(dir, "b.jpg");
  fs.writeFileSync(f, await bg.processBgImage(png(1200, 800)));
  await preloadPnlBackground(f);
  const out = renderPnlCard({ ...bg.sampleCardData(), background: f, bgDarkPct: 80, bgBlur: 6 });
  assert.ok(out.length > 10_000);
});

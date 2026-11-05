# DLMM Bot Full — Telegram Meteora DLMM (self-signing)

Bot self-host untuk deploy / claim / remove / swap posisi [Meteora DLMM](https://app.meteora.ag/) lewat Telegram.

> ## ⚠️ PERINGATAN KEAMANAN (WAJIB BACA)
>
> Bot ini **menandatangani transaksi sendiri** memakai `WALLET_PRIVATE_KEY` dari file `.env`.
>
> 1. **Buat wallet Solana BARU yang terpisah** — jangan pakai wallet utama.
> 2. Isi **dana kecil saja** (tanpa batas USD untuk swap maupun posisi — hanya cek saldo SOL).
> 3. **Jangan pernah** kirim private key / seed phrase lewat chat Telegram, email, atau commit git.
> 4. Isi key **sendiri** di file `.env` di server lokalmu, lalu:
>    ```bash
>    chmod 600 .env
>    ```
>    Bot **menolak start** jika permission `.env` bukan `600`.
> 5. Default `DRY_RUN=true` (simulasi). Set `false` hanya setelah kamu paham risikonya.
> 6. Hanya user ID di `ALLOWED_TELEGRAM_USER_IDS` yang bisa memerintah bot.

Kalau kamu tidak nyaman menyimpan private key di server, pakai `bot-safe/` (tanda tangan Phantom manual).

## Fitur

| Command | Fungsi |
|---|---|
| `/pools <query\|mint>` | Cari pool DLMM |
| `/add` | Wizard deploy: pool → Spot/Curve/BidAsk → one/two-sided → amount → range → **Confirm** |
| `/positions` | Posisi on-chain + nilai/PnL/fees **USD** |
| `/claim` `/remove` | Claim / remove+close (butuh Confirm) |
| `/swap` | Jupiter swap (butuh Confirm) |
| `/reshape` | Claim fee + withdraw bin token + re-add BidAsk (butuh Confirm) |
| `/zapout` | Claim → close 100% → swap semua token non-SOL ke SOL (Confirm) |
| `/balance` | SOL/USDC (+ USD) |
| `/settings` | DRY_RUN, caps, slippage, strategi |
| *(paste mint/CA)* | Deteksi alamat Solana → daftar pool DLMM → wizard `/add` |

Setiap deploy / swap / claim / remove menampilkan ringkasan + tombol **Confirm / Cancel** (timeout **60 detik**). Tidak ada trade otomatis / terjadwal.

**Tanpa batas USD:** swap dan ukuran posisi tidak dibatasi USD (`MAX_SWAP_USD` lama diabaikan); sebelum Preview bot cek saldo SOL cukup (amount + rent + bin array + fee).



## /zapout

Keluar dari posisi sekaligus:

1. Claim swap fee (skip jika 0).
2. Remove liquidity 100% + close posisi.
3. Swap **semua** token non-SOL yang baru masuk ke wallet (delta saldo aktual = withdrawn + fee token) ke SOL via Jupiter.

Satu ringkasan (est. USD, slippage) + Confirm/Cancel 60 detik. Tx berurutan; partial failure dilaporkan jelas. `DRY_RUN` mensimulasikan.

**Swap:** semua token non-SOL di-swap ke SOL; token tanpa rute Jupiter tetap di wallet.

## Slippage

| Env / setting | Default | Unit ke SDK |
|---|---|---|
| `SWAP_SLIPPAGE_PCT` | 10 | Jupiter `slippageBps` = pct × 100 (10% → 1000) |
| `LIQ_SLIPPAGE_PCT` | 10 | Meteora `@meteora-ag/dlmm` **percentage** as-is (bukan bps!) |

Temuan SDK 1.9.4: `getSlippageMaxAmount` memakai `(100 + slippage) / 100` dan `slippage == 100` = 100%. Nilai lama `1000` di kode referensi **salah** jika dimaksudkan 10% bps. Ubah lewat `/settings` (0.1–50%, tersimpan di `data/settings.json`).

## Paste mint (CA)

Kirim alamat mint Solana polos (base58 32–44, valid `PublicKey`) di chat. Bot mencari pool DLMM (Meteora datapi), menampilkan hingga 8 pool (urut TVL/volume) sebagai tombol, lalu masuk wizard `/add` (amount → strategi → range → Confirm).

## /reshape

Alur untuk posisi one-sided SOL yang sebagian bin sudah jadi token (non-SOL):

1. Baca posisi → tampilkan breakdown **per bin token** (jumlah + USD) + fee belum di-claim.
2. **Claim** swap fee (`claimSwapFee`). Fee token ikut dihitung; fee SOL tetap di wallet (tidak di-re-add). Jika fee ≈ 0, langkah claim di-skip.
3. **Withdraw hanya bin yang memegang token** (`removeLiquidity` 100% bps per rentang kontigu). Bin SOL-only **tidak** disentuh. Bin campuran (token+SOL) ikut di-withdraw — bagian SOL kembali ke wallet.
4. **Re-add** jumlah aktual = delta saldo token wallet setelah claim+withdraw (bukan estimasi) sebagai posisi **baru**, single-sided token, strategi default **BidAsk** (bisa dipilih), range **di atas** active bin. Lebar default = jumlah bin token yang di-withdraw (max 69, bisa diubah).
5. Satu ringkasan + tombol **Confirm/Cancel** (60 detik) sebelum eksekusi. Tx dijalankan berurutan; setiap signature dilaporkan. `DRY_RUN=true` mensimulasikan semua langkah.

**Edge case:** tidak ada bin token → bot menolak dengan pesan jelas. Gagal di tengah → laporan langkah mana yang sudah sukses (claim/withdraw/re-add).

## Strategi modular

Di `src/strategies/`: `spot.ts`, `curve.ts`, `bidask.ts`.

Tambah strategi baru:

1. Buat `src/strategies/nama.ts` (`StrategyDefinition`).
2. Daftarkan di `src/strategies/index.ts`.
3. `npm run build`.

## Setup

Butuh **Node.js ≥ 20**.

```bash
cd bot-full
npm install
cp .env.example .env
chmod 600 .env
nano .env   # isi sendiri — jangan paste key ke chat
```

### Variabel `.env`

| Variabel | Wajib | Keterangan |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Dari @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Chat id kamu |
| `ALLOWED_TELEGRAM_USER_IDS` | ✅ | Whitelist user id (koma) |
| `WALLET_PRIVATE_KEY` | ✅ | base58 secret — **wallet terpisah dana kecil** |
| `RPC_URL` | ✅ | RPC mainnet (Helius dll) |
| `DRY_RUN` | | default `true` |
| `HELIUS_API_KEY` / `JUPITER_API_KEY` | | opsional |

### BotFather

1. `/newbot` → salin token ke `.env`.
2. Chat botmu, ambil user id dari @userinfobot → isi `ALLOWED_TELEGRAM_USER_IDS` dan `TELEGRAM_CHAT_ID`.

## Menjalankan

```bash
# development
npm run dev

# production
npm run build
npm start
```

Coba command baca dulu (`/balance`, `/pools`, `/positions`) dengan `DRY_RUN=true` sebelum deploy dana sungguhan.

### Docker

```bash
docker build -t dlmm-bot-full .
docker run --rm --env-file .env dlmm-bot-full
```

Pastikan file `.env` di host `chmod 600`.

### systemd

Lihat `deploy/dlmm-bot-full.service`.

## Tes

```bash
npm test
```

Tes mencakup redaksi key di logger, whitelist Telegram, caps USD, alur Confirm, dan DRY_RUN — **tanpa** key / dana nyata.

## Batasan

- Range maksimal **69 bins** per posisi (satu tx standar), termasuk re-add `/reshape`.
- `/reshape` memakai delta saldo wallet aktual; RPC lambat bisa membuat delay singkat antar langkah.
- Bin campuran (token+SOL) ikut ter-withdraw saat reshape.
- Tidak ada auto-swap setelah `/remove` — pakai `/swap` terpisah.
- Private key hanya dari `.env`; bot tidak menerima key lewat chat.
- Risiko key bocor = dana di wallet bot bisa dikuras. Tetap pakai wallet kecil terpisah.

## Referensi

Perilaku on-chain mengacu pada `../DLMM-manual-byPureXBT/`. Desain awal: `../DESIGN.md`.

## Multi-user (wallet per user)

- **Owner** = `OWNER_TELEGRAM_ID` (or the first id in `ALLOWED_TELEGRAM_USER_IDS`). Owner uses `WALLET_PRIVATE_KEY` from `.env`.
- Other users: owner adds them with **/admin → ➕ Tambah user** (send numeric Telegram ID). Stored in `DATA_DIR/users.json` (ids in `.env` whitelist still work too). The bot DMs them an onboarding message with **🆕 Buat wallet**; if the DM fails, ask them to open the bot and send `/start`.
- Unknown users get `⛔ akses ditolak`.
- Each user has their own wallet, positions, settings, session, confirms and PnL records (`DATA_DIR/users/<id>/`). Nobody can see or act on another user's wallet/positions. Caps and `DRY_RUN` from `.env` apply to everyone.
- **The bot never asks for a private key / seed in chat.**

### Setup (owner, once)
```bash
openssl rand -hex 32          # copy output
nano .env                     # WALLET_ENCRYPTION_KEY=<output>   (optional OWNER_TELEGRAM_ID=<your id>)
chmod 600 .env && npm run build && <restart bot>
```

### Import an existing wallet for a friend (via VPS file, not chat)
1. Get the friend's Telegram user ID and add it: `/admin → ➕ Tambah user`.
2. On the VPS put their key in a file named after their id:
   ```bash
   mkdir -p data/wallets/import && chmod 700 data/wallets data/wallets/import
   nano data/wallets/import/<userId>.json    # Solana keypair JSON array [12,34,...] (64 numbers) OR base58 secret string
   chmod 600 data/wallets/import/<userId>.json
   ```
   (`data` = your `DATA_DIR`.)
3. In Telegram: `/admin → 📥 Import dari file VPS → <userId>`.
4. The bot encrypts it into `data/wallets/<userId>.json` (chmod 600), verifies it decrypts, then overwrites + deletes the plaintext import file, and DMs the user their address. If the file is invalid it is left untouched.
5. Clear shell history if you pasted the key in a command: `history -c`.

### Backup (important)
Back up **both** together, stored separately and offline:
- `DATA_DIR/wallets/` (encrypted wallet files), and
- `WALLET_ENCRYPTION_KEY` from `.env`.

Without the key the wallet files are useless; with both, anyone can spend the funds. Removing a user in /admin only revokes access — their encrypted wallet file stays so funds remain recoverable (users can also 📤 Withdraw SOL from 👛 Wallet, with Confirm).

## Range lebar (>69 bins, maks 1400) & Range %

- Default tetap preset bins (20/40/69). Di panel /add → ✏️ Range: preset bins, preset % (atur di Settings → ✏️ Range % presets), atau **✏️ Range %**:
  - SOL side: atas tetap 0% → ketik `50` atau `0-50` = −50%..0%
  - Token side: bawah tetap 0% → `50` / `0-50` = 0%..+50%
  - Double side: `-50 +20`, `-50..+20`, `50 20`, atau `30` (±30%)
  - Bins dihitung dari bin step pool dan selalu ditampilkan bersama % dan harga.
- ≤69 bins → 1 tx seperti biasa. >69 bins → posisi lebar (extended): tx buat+extend posisi, lalu add liquidity per ±70 bins.
- Preview menampilkan jumlah tx, rent posisi (kembali saat close) dan rent bin array baru (TIDAK kembali).
- Jika deploy berhenti di tengah: pesan gagal punya tombol **▶️ Retry / lanjutkan** (kirim sisa chunk, distribusi dihitung ulang dari harga sekarang) dan **🚪 Exit**.
- Exit/Zapout/Claim/Reshape posisi lebar dikirim multi-tx berurutan dengan retry blockhash; status menampilkan progres `n/N tx`.
- Tidak ada cap USD posisi; saldo SOL dicek sebelum Preview.

## Strategi Mix

- Mix = BidAsk X% + Spot (100−X)% di posisi & range yang sama (default 70/30, Settings → ✏️ Mix ratio).
- Satu Confirm untuk keduanya; preview menampilkan pembagian. Jika langkah Spot gagal → ▶️ Retry / 🚪 Exit. Kartu posisi menampilkan `Mix 70/30`.

## 🔎 Pool scanner (read-only)

`npm run scan` atau `/scan` di Telegram: scan pool DLMM pasangan SOL dari Meteora datapi, ranking skor 0–100
(fee APR 40% · fees 24h 25% · volume 24h 20% · TVL 15%, log-scaled, −5 per risk flag). Hasil top N disimpan di
`DATA_DIR/scan/latest.json`. **Tidak ada transaksi / auto-trade.** `/scan` memakai cache ≤10 menit.

Risk flags: `LOW_TVL`, `APR_VS_TVL` (APR >2000% di TVL <$100K), `NEW_POOL`, `LOW_FEE_VOL` (fee/volume < ½ base fee),
`VOL_SPIKE` (vol >50× TVL), `FREEZE_AUTH`, `UNVERIFIED`, `FEW_HOLDERS` (<500). Mint authority tidak tersedia murah di datapi → tidak dicek.

Env: `SCAN_MIN_TVL` (10000), `SCAN_MIN_VOL24H` (25000), `SCAN_MAX_BIN_STEP` (200), `SCAN_MIN_BIN_STEP` (1), `SCAN_TOP_N` (15, max 50),
`SCAN_PAGES` (3 × 100 pool, urut volume), `SCAN_NEW_POOL_HOURS` (24). HTTP opsional: `SCAN_HTTP_TOKEN` (wajib untuk aktif),
`SCAN_HTTP_PORT` (8787), `SCAN_HTTP_HOST` (127.0.0.1) → `GET /scan/latest` dengan `Authorization: Bearer <token>`.

# DLMM Bot Full — Telegram Meteora DLMM (self-signing)

Bot self-host untuk deploy / claim / remove / swap posisi [Meteora DLMM](https://app.meteora.ag/) lewat Telegram.

> ## ⚠️ PERINGATAN KEAMANAN (WAJIB BACA)
>
> Bot ini **menandatangani transaksi sendiri** memakai `WALLET_PRIVATE_KEY` dari file `.env`.
>
> 1. **Buat wallet Solana BARU yang terpisah** — jangan pakai wallet utama.
> 2. Isi **dana kecil saja** (sesuai `MAX_POSITION_USD` / `MAX_SWAP_USD`, default $100).
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
| `/balance` | SOL/USDC (+ USD) |
| `/settings` | DRY_RUN, caps, strategi |

Setiap deploy / swap / claim / remove menampilkan ringkasan + tombol **Confirm / Cancel** (timeout **60 detik**). Tidak ada trade otomatis / terjadwal.

**Batas keras:** `MAX_POSITION_USD=100`, `MAX_SWAP_USD=100` (bisa diubah di `.env`).


## /reshape

Alur untuk posisi one-sided SOL yang sebagian bin sudah jadi token (non-SOL):

1. Baca posisi → tampilkan breakdown **per bin token** (jumlah + USD) + fee belum di-claim.
2. **Claim** swap fee (`claimSwapFee`). Fee token ikut dihitung; fee SOL tetap di wallet (tidak di-re-add). Jika fee ≈ 0, langkah claim di-skip.
3. **Withdraw hanya bin yang memegang token** (`removeLiquidity` 100% bps per rentang kontigu). Bin SOL-only **tidak** disentuh. Bin campuran (token+SOL) ikut di-withdraw — bagian SOL kembali ke wallet.
4. **Re-add** jumlah aktual = delta saldo token wallet setelah claim+withdraw (bukan estimasi) sebagai posisi **baru**, single-sided token, strategi default **BidAsk** (bisa dipilih), range **di atas** active bin. Lebar default = jumlah bin token yang di-withdraw (max 69, bisa diubah).
5. Satu ringkasan + tombol **Confirm/Cancel** (60 detik) sebelum eksekusi. Tx dijalankan berurutan; setiap signature dilaporkan. Cap `MAX_POSITION_USD` dicek pada nilai re-add. `DRY_RUN=true` mensimulasikan semua langkah.

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
| `MAX_POSITION_USD` / `MAX_SWAP_USD` | | default `100` |
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

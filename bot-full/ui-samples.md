# DLMM bot — UI samples

`**x**` = bold, backtick = tap-to-copy. Max line excludes addresses (own line).

## Pool picker (+ 1 button per pool)

_max line: 30 chars_

```
**🏊 Pilih pool DLMM**

1. **SOL-USDC**
   TVL $4.47M · Vol 24h $32.3M
   Fee 24h $13.8K (0.31% TVL)
   Total fee $11.7M
   Bin step 4 · fee 0.04%

2. **Donkey-SOL**
   TVL $182K · Vol 24h $940K
   Fee 24h $9.4K (5.16% TVL)
   Total fee $211K
   Bin step 100 · fee 1%
```

## /add Preview

_max line: 27 chars_

```
**👀 Preview Add LP**

Pool: Donkey-SOL
Mode: ⚠️ LIVE

**💵 Amount**
Total: 0.5 SOL
Sisi: SOL side
Strategi: Mix 70/30
BidAsk 70%: 0.35 SOL
Spot 30%: 0.15 SOL
Nilai: $48.50 / cap $100.00

**📐 Range**
Bins: 70 (70↓ 0↑)
Persen: −50.2% / +0%
Min: 0.0₅206 ($0.0001998)
Max: 0.0₅414 ($0.0004016)
MC: $2.06M–$4.14M
MC now: $4.14M

**🧾 Biaya**
Tx: 3
Rent pos: ≈0.0582 SOL
  (kembali saat close)
Bin array: ≈0 SOL
  (tidak kembali)
Slippage: 10%

📍 Posisi baru
`7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg`
⏳ Konfirmasi 60s
```

## Position card

_max line: 43 chars_

```
**Donkey/SOL** 7b9f…1tcg [Mix 70/30 · 70 bins]

📊 Value: $49.06
📈 +$0.91 (+1.88%)
💵 Fee berjalan: $0.62

📐 0.0₅116–0.0₅425 (now 0.0₅414) Donkey/SOL
🏷 MC $1.16M–$4.25M (now $4.14M)
−72% ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬● +3%

🟢 In-range

🕐 3j 20m · updated 00:30:00 KST
[Meteora](https://app.meteora.ag/dlmm/5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6) · [Solscan](https://solscan.io/account/7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg)
`7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg`
```

## Positions list (+ 1 button per posisi)

_max line: 18 chars_

```
**📊 Posisi DLMM (2)**

Total: $98.12
Fee: $1.24
In range: 1/2

Pilih posisi ⬇️
🕐 00:46:38 KST
```

## Close / Zapout result (+ ℹ️ Detail button)

_max line: 27 chars_

```
✅ **Zapout Donkey/SOL**
PnL: 🟢 +$0.91 (+1.88%)
Realized: +0.5509 SOL
(+rent, −fee tx & slippage)
Waktu: 3.0s
[🧾 Tx Solscan](https://solscan.io/tx/5xTxSig) +1
```

## Close error

_max line: 21 chars_

```
❌ **Exit AMD/SOL gagal**
block height exceeded
```

## Wallet

_max line: 21 chars_

```
**👛 Wallet · owner**

`9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin`
[Solscan](https://solscan.io/account/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin)

**💰 Saldo**
SOL: 1.2345 ($119.75)
USDC: 12.5
Total: $132.25

**🔒 Batas**
Mode: ⚠️ LIVE
Cap posisi: $100.00
Cap swap: $100.00
```

## Admin

_max line: 21 chars_

```
**🛡 Admin**

Owner: `111`
Enkripsi: ✅ key diset

**👥 User (1)**
`222333444`
  👛 belum ada
```

## Settings

_max line: 27 chars_

```
**⚙️ Settings**

**🛡 Konfirmasi**
Auto close: OFF
Semua aksi pakai Confirm

**🎚 Slippage**
Swap: 10%
Liquidity: 10%

**🚀 Priority fee**
DLMM: auto
Jup maks: 1000000 lamports

**📏 Range & amount**
Bins: 20 / 40 / 69
Range %: −50%..0%, −70%..0%
Amount: 0.5 / 1 / 2 SOL
Mix: BidAsk 70 / Spot 30

**🔒 Dari .env**
Mode: ⚠️ LIVE
Cap posisi: $100.00
Cap swap: $100.00
```

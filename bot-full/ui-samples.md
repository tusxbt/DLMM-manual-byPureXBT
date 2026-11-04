# DLMM bot — UI samples

`**x**` = bold, backtick = tap-to-copy. Max line excludes addresses (own line).

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

_max line: 23 chars_

```
**Donkey/SOL · DLMM**

🟢 In range
Strategi: Mix 70/30

**💰 PnL**
PnL: 🟢 +$0.91 (+1.88%)
Sumber: Meteora
Value: $49.06
Deposit: $48.56
Fee unclaim: $0.62
Fee total: $1.03

**📐 Range**
Min: 0.0₅116
Max: 0.0₅425
Now: 0.0₅414
−72% ━━━━━━━━━━━● +3%
Bins: 70
MC: $1.16M–$4.25M
MC now: $4.14M

**ℹ️ Info**
Umur: 3j 20m
Update: 00:30:00 KST
📍 Posisi
`7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg`
🏊 Pool
`5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6`
[Meteora](https://app.meteora.ag/dlmm/5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6) · [Solscan](https://solscan.io/account/7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg)
```

## Positions list (+ 1 button per posisi)

_max line: 18 chars_

```
**📊 Posisi DLMM (2)**

Total: $98.12
Fee: $1.24
In range: 1/2

Pilih posisi ⬇️
🕐 00:38:39 KST
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

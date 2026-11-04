import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { prepareTx, MAX_SEND_ATTEMPTS } from "../src/engine/executor.js";
import { parsePriceResponse } from "../src/engine/prices.js";
import { depositUsd, defaultPanel } from "../src/telegram/add-panel.js";
import { positionButtonLabel, renderPositionCard } from "../src/telegram/positions-view.js";

const OLD = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 };
const NEW = { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 999 };

function addLike(wallet: Keypair, position: Keypair): string {
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: position.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }),
  );
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = OLD.blockhash;
  tx.partialSign(position);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

test("add tx: fresh blockhash + re-signed by wallet AND same position keypair", () => {
  const w = Keypair.generate();
  const pos = Keypair.generate();
  const s = prepareTx({ serialized: addLike(w, pos), encoding: "legacy", label: "add", coSigners: [pos] }, [w, pos], NEW);
  assert.equal(s.blockhash, NEW.blockhash);
  assert.equal(s.lastValid, 999);
  assert.ok((s.tx as Transaction).verifySignatures());
});

test("without co-signer: keeps original blockhash + partial sig (no unsafe refresh)", () => {
  const w = Keypair.generate();
  const pos = Keypair.generate();
  const s = prepareTx({ serialized: addLike(w, pos), encoding: "legacy", label: "add" }, [w], NEW);
  assert.equal(s.blockhash, OLD.blockhash);
  assert.ok((s.tx as Transaction).verifySignatures());
});

test("versioned (Jupiter) tx gets fresh blockhash", () => {
  const w = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: w.publicKey,
    recentBlockhash: OLD.blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: w.publicKey, lamports: 1 })],
  }).compileToV0Message();
  const v = new VersionedTransaction(msg);
  const s = prepareTx({ serialized: Buffer.from(v.serialize()).toString("base64"), encoding: "versioned", label: "swap" }, [w], NEW);
  assert.equal(s.blockhash, NEW.blockhash);
  assert.equal(MAX_SEND_ATTEMPTS, 3);
});

test("price v3 parsing; zero/invalid dropped", () => {
  assert.deepEqual(parsePriceResponse({ A: { usdPrice: 92.8 }, B: { usdPrice: 0 }, C: null }), { A: 92.8 });
  assert.deepEqual(parsePriceResponse({ data: { A: { price: "1.5" } } }), { A: 1.5 });
});

test("unknown SOL price never passes cap as $0; value n/a shown", () => {
  assert.equal(depositUsd({ ...defaultPanel(), amountSol: 1 }), null);
  assert.equal(depositUsd({ ...defaultPanel(), amountSol: 1, solUsd: 100 }), 100);
  const p = { position: "P1", pool: "X", pair: "AMD/SOL", total_value_usd: null, unclaimed_fees_usd: null, pnl_usd: null, pnl_pct: null, in_range: true } as never;
  assert.equal(positionButtonLabel(p), "🟢 AMD/SOL n/a");
  assert.match(renderPositionCard(p), /Value: n\/a/);
  assert.doesNotMatch(renderPositionCard(p), /\$0\.00/);
});

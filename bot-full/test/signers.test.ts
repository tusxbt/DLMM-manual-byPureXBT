import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { assertAllSigned, signLegacyPreserving } from "../src/engine/executor.js";

const BH = "11111111111111111111111111111111";

/** Mimics initializePositionAndAddLiquidity: wallet pays, position keypair must co-sign. */
function buildTwoSignerTx(wallet: Keypair, position: Keypair): Transaction {
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: position.publicKey,
      lamports: 1,
      space: 0,
      programId: SystemProgram.programId,
    }),
  );
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = BH;
  tx.partialSign(position);
  return tx;
}

test("position partial signature survives serialize → deserialize → wallet partialSign", () => {
  const wallet = Keypair.generate();
  const position = Keypair.generate();
  const blob = buildTwoSignerTx(wallet, position).serialize({ requireAllSignatures: false, verifySignatures: false });
  const tx = Transaction.from(blob);
  signLegacyPreserving(tx, [wallet]);
  assert.doesNotThrow(() => assertAllSigned(tx, "add"));
  assert.equal(tx.recentBlockhash, BH);
});

test("old behaviour (tx.sign(wallet)) drops position sig → pre-send check names the key", () => {
  const wallet = Keypair.generate();
  const position = Keypair.generate();
  const tx = Transaction.from(buildTwoSignerTx(wallet, position).serialize({ requireAllSignatures: false }));
  tx.sign(wallet); // what sendAndConfirmTransaction did internally
  assert.throws(() => assertAllSigned(tx, "add"), new RegExp(position.publicKey.toBase58()));
});

test("ignore list (DRY_RUN check) skips wallet but still requires position", () => {
  const wallet = Keypair.generate();
  const position = Keypair.generate();
  const tx = Transaction.from(buildTwoSignerTx(wallet, position).serialize({ requireAllSignatures: false }));
  assert.doesNotThrow(() => assertAllSigned(tx, "add", [wallet.publicKey.toBase58()]));
  const noPos = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: position.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }),
  );
  noPos.feePayer = wallet.publicKey;
  noPos.recentBlockhash = BH;
  assert.throws(() => assertAllSigned(noPos, "add", [wallet.publicKey.toBase58()]), /Signer kurang/);
});

test("versioned: sign keeps other signatures; missing detected", () => {
  const wallet = Keypair.generate();
  const position = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: BH,
    instructions: [
      SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: position.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }),
    ],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([position]);
  assert.throws(() => assertAllSigned(vtx, "v"), new RegExp(wallet.publicKey.toBase58()));
  const back = VersionedTransaction.deserialize(vtx.serialize());
  back.sign([wallet]);
  assert.doesNotThrow(() => assertAllSigned(back, "v"));
});

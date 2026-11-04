import type { Signer } from "@solana/web3.js";

/** Shared tx item type used by builders + executor. */
export type PendingTxItem = {
  /** base64 serialized VersionedTransaction or legacy Transaction */
  serialized: string;
  /** legacy | versioned */
  encoding: "legacy" | "versioned";
  label: string;
  /**
   * In-memory only co-signers (e.g. ephemeral position keypair) so the executor can
   * re-sign after refreshing the blockhash. Never serialized, logged, or persisted.
   */
  coSigners?: Signer[];
};

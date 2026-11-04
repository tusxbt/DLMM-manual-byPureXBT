/** Shared tx item type used by builders + executor. */
export type PendingTxItem = {
  /** base64 serialized VersionedTransaction or legacy Transaction */
  serialized: string;
  /** legacy | versioned */
  encoding: "legacy" | "versioned";
  label: string;
};

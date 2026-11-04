import crypto from "node:crypto";

/** WALLET_ENCRYPTION_KEY: 32 bytes as 64 hex chars or base64. null if missing/invalid. */
export function encryptionKey(raw = process.env.WALLET_ENCRYPTION_KEY?.trim()): Buffer | null {
  if (!raw) return null;
  let k: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) k = Buffer.from(raw, "hex");
  else {
    try {
      const b = Buffer.from(raw, "base64");
      if (b.length === 32) k = b;
    } catch {
      /* invalid */
    }
  }
  return k && k.length === 32 ? k : null;
}

export type EncBlob = { v: 1; alg: "aes-256-gcm"; iv: string; tag: string; ct: string };

export function encryptSecret(secret: Uint8Array, key: Buffer): EncBlob {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function decryptSecret(b: EncBlob, key: Buffer): Uint8Array {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv, "base64"));
  d.setAuthTag(Buffer.from(b.tag, "base64"));
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(b.ct, "base64")), d.final()]));
}

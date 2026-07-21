import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM, from Node's standard library — no dependency to audit.
 *
 * GCM is authenticated: a modified ciphertext fails to decrypt rather than
 * producing plausible rubbish, which is what you want for a value that will be
 * handed to a build as a password.
 *
 * Payload format: `v1.<iv>.<tag>.<ciphertext>`, each part base64. The version
 * prefix exists so the format can be changed without guessing what old rows are.
 */
const VERSION = "v1";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(
    ".",
  );
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, bodyB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || bodyB64 === undefined) {
    throw new Error("Unrecognised secret format");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, "base64")), decipher.final()]).toString("utf8");
}

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../../src/secrets/cipher.js";

const key = randomBytes(32);

describe("encrypt / decrypt", () => {
  it("returns what was put in", () => {
    for (const value of ["", "hunter2", "a".repeat(4096), "clé: éàü 🔑"]) {
      expect(decrypt(encrypt(value, key), key)).toBe(value);
    }
  });

  it("produces a different ciphertext every time for the same input", () => {
    // A deterministic ciphertext would leak that two projects share a password.
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("carries a version marker so the format can change later", () => {
    expect(encrypt("x", key).startsWith("v1.")).toBe(true);
  });

  it("refuses a tampered ciphertext instead of returning garbage", () => {
    const payload = encrypt("hunter2", key);
    const parts = payload.split(".");
    const body = Buffer.from(parts[3]!, "base64");
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString("base64");

    expect(() => decrypt(parts.join("."), key)).toThrow();
  });

  it("refuses the wrong key", () => {
    expect(() => decrypt(encrypt("hunter2", key), randomBytes(32))).toThrow();
  });

  it("refuses a payload in an unknown format", () => {
    expect(() => decrypt("v2.a.b.c", key)).toThrow(/format/i);
    expect(() => decrypt("nonsense", key)).toThrow(/format/i);
  });
});

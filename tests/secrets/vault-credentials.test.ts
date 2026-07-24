import { describe, expect, it } from "vitest";
import { CredentialStore } from "../../src/db/credentials.js";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";
import { defaultVarNames } from "../../src/credentials/kinds.js";
import { Vault } from "../../src/secrets/vault.js";
import { tmpDir } from "../fixtures/repos.js";

async function vault() {
  const db = openDatabase(":memory:");
  const v = await Vault.open(await tmpDir("laneyard-vault-cred-"), new SecretStore(db), new CredentialStore(db));
  return { vault: v, db };
}

const KEYSTORE_FIELDS = {
  key_alias: "upload",
  store_password: "correct-horse-battery",
  key_password: "staple-battery-horse",
};

describe("Vault credential blocks", () => {
  it("round-trips a binary file byte for byte", async () => {
    const { vault: v } = await vault();
    const bytes = Buffer.from([0xfe, 0xed, 0x00, 0xff, 0x80, 0x7f]);

    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: bytes,
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });

    const block = v.resolveCredential("app", "android_keystore");
    expect(block?.fileName).toBe("upload.jks");
    expect(block?.fileBytes.equals(bytes)).toBe(true);
    expect(block?.fields).toEqual(KEYSTORE_FIELDS);
  });

  it("lists a block without exposing what is in it", async () => {
    const { vault: v } = await vault();
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: Buffer.from("keystore"),
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });

    const summary = v.listCredentials("app");
    expect(summary).toHaveLength(1);
    expect(summary[0]!.kind).toBe("android_keystore");
    expect(summary[0]!.varNames["store_password"]).toBe("ANDROID_KEYSTORE_PASSWORD");
    expect(JSON.stringify(summary)).not.toContain(KEYSTORE_FIELDS.store_password);
  });

  it("attaches the fields that are not secret, and only those", async () => {
    const { vault: v } = await vault();
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: Buffer.from("keystore"),
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });

    const listed = v.listCredentialsWithFields("app");
    // The alias is readable, which is the point: `stored` said the same word
    // about a right one and one missing a character.
    expect(listed[0]!.fields).toEqual({ key_alias: "upload" });
    expect(JSON.stringify(listed)).not.toContain(KEYSTORE_FIELDS.store_password);
    expect(JSON.stringify(listed)).not.toContain(KEYSTORE_FIELDS.key_password);

    expect(v.revealCredentialField("app", "android_keystore", "store_password")).toBe(
      KEYSTORE_FIELDS.store_password,
    );
    expect(v.revealCredentialField("app", "apple_asc", "key_id")).toBeNull();
  });

  it("keeps its summary when a block will not decrypt", async () => {
    const { vault: v, db } = await vault();
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: Buffer.from("keystore"),
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });
    db.prepare("UPDATE credential SET fields_enc = ? WHERE kind = ?").run("v1.aaaa.bbbb.cccc", "android_keystore");

    const listed = v.listCredentialsWithFields("app");
    expect(listed[0]!.fileName).toBe("upload.jks");
    expect(listed[0]!.fields).toEqual({});
  });

  it("refuses to hand back a block it cannot decrypt", async () => {
    const { vault: v, db } = await vault();
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: Buffer.from("keystore"),
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });
    db.prepare("UPDATE credential SET file_enc = ? WHERE kind = ?").run("v1.aaaa.bbbb.cccc", "android_keystore");

    expect(() => v.resolveCredential("app", "android_keystore")).toThrow(/android_keystore/);
  });

  it("keeps a block's passwords out of the logs", async () => {
    const { vault: v } = await vault();
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: Buffer.from("keystore"),
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });

    const masked = v.maskedValues("app");
    expect(masked).toContain(KEYSTORE_FIELDS.store_password);
    expect(masked).toContain(KEYSTORE_FIELDS.key_password);
    expect(masked).not.toContain(KEYSTORE_FIELDS.key_alias);
  });
});

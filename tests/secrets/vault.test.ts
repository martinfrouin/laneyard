import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { tmpDir } from "../fixtures/repos.js";

async function vault() {
  const db = openDatabase(":memory:");
  return {
    vault: await Vault.open(await tmpDir("laneyard-vault-"), new SecretStore(db), new CredentialStore(db)),
    db,
  };
}

describe("Vault", () => {
  it("round-trips a value through storage", async () => {
    const { vault: v } = await vault();
    await v.set("app", "TOKEN", "hunter2", true);
    expect(v.resolve("app")).toEqual({ TOKEN: "hunter2" });
  });

  it("stores ciphertext, never the value", async () => {
    const { vault: v, db } = await vault();
    await v.set("app", "TOKEN", "hunter2", true);

    const stored = db.prepare("SELECT value_enc FROM secret").get() as { value_enc: string };
    expect(stored.value_enc).not.toContain("hunter2");
    expect(stored.value_enc.startsWith("v1.")).toBe(true);
  });

  it("returns only the values worth hiding from a log", async () => {
    const { vault: v } = await vault();
    await v.set("app", "SECRET", "hide-me", true);
    await v.set("app", "PUBLIC", "keep-me", false);

    expect(v.maskedValues("app").sort()).toEqual(["hide-me"]);
  });

  it("survives a secret it can no longer decrypt", async () => {
    const { vault: v, db } = await vault();
    await v.set("app", "GOOD", "fine", true);
    db.prepare("INSERT INTO secret (project_slug, key, value_enc, masked, updated_at) VALUES (?,?,?,?,?)")
      .run("app", "BROKEN", "v1.aaaa.bbbb.cccc", 1, new Date().toISOString());

    // One unreadable row must not take the whole run down with it.
    const resolved = v.resolve("app");
    expect(resolved["GOOD"]).toBe("fine");
    expect(resolved["BROKEN"]).toBeUndefined();
  });
});

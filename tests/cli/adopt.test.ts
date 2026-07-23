import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAdoption } from "../../src/cli/adopt.js";
import { acceptingAsker } from "../../src/cli/prompt.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { tmpDir } from "../fixtures/repos.js";

/** A `confirm` that says no to everything, whatever the default. */
const refusingAsker = { ...acceptingAsker, async confirm() { return false; } };

async function project(fastfile: string, files: Record<string, string> = {}) {
  const dir = await tmpDir("laneyard-adopt-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  await writeFile(join(dir, "fastlane", "Fastfile"), fastfile, "utf8");
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, "utf8");
  }
  const home = await tmpDir("laneyard-home-");
  const db = openDatabase(join(home, "laneyard.db"));
  const vault = await Vault.open(home, new SecretStore(db), new CredentialStore(db));
  return { dir, home, db, vault };
}

const WITH_JSON = `lane :beta do\n  supply(json_key: "./play.json")\nend\n`;

describe("runAdoption", () => {
  it("stores the block and patches the Fastfile when accepted", async () => {
    const { dir, vault, db } = await project(WITH_JSON, { "play.json": `{"type":"service_account"}` });
    try {
      await runAdoption({ cwd: dir, fastlaneDir: "fastlane", slug: "app", vault, asker: acceptingAsker });

      expect(vault.listCredentials("app").map((c) => c.kind)).toEqual(["play_service_account"]);
      const after = await readFile(join(dir, "fastlane", "Fastfile"), "utf8");
      expect(after).toBe(`lane :beta do\n  supply(json_key: ENV.fetch("SUPPLY_JSON_KEY"))\nend\n`);
    } finally {
      db.close();
    }
  });

  it("writes nothing at all when declined", async () => {
    const { dir, vault, db } = await project(WITH_JSON, { "play.json": `{}` });
    try {
      await runAdoption({ cwd: dir, fastlaneDir: "fastlane", slug: "app", vault, asker: refusingAsker });

      expect(vault.listCredentials("app")).toEqual([]);
      expect(await readFile(join(dir, "fastlane", "Fastfile"), "utf8")).toBe(WITH_JSON);
    } finally {
      db.close();
    }
  });

  it("proposes nothing when the literal names a file that is not there", async () => {
    const { dir, vault, db } = await project(WITH_JSON);
    try {
      const res = await runAdoption({ cwd: dir, fastlaneDir: "fastlane", slug: "app", vault, asker: acceptingAsker });

      expect(res.applied).toBe(0);
      expect(vault.listCredentials("app")).toEqual([]);
      expect(await readFile(join(dir, "fastlane", "Fastfile"), "utf8")).toBe(WITH_JSON);
    } finally {
      db.close();
    }
  });

  it("leaves the Fastfile untouched when the vault write fails", async () => {
    const { dir, db } = await project(WITH_JSON, { "play.json": `{}` });
    const broken = {
      listCredentials: () => [],
      async setCredential() { throw new Error("vault is sealed"); },
    } as unknown as Vault;
    try {
      await expect(
        runAdoption({ cwd: dir, fastlaneDir: "fastlane", slug: "app", vault: broken, asker: acceptingAsker }),
      ).rejects.toThrow(/sealed/);
      expect(await readFile(join(dir, "fastlane", "Fastfile"), "utf8")).toBe(WITH_JSON);
    } finally {
      db.close();
    }
  });

  it("restores the Fastfile if the patch stops it parsing", async () => {
    // A pair range deliberately mis-stated would break the file; the re-parse
    // must catch it and put the original back.
    const { dir, vault, db } = await project(WITH_JSON, { "play.json": `{}` });
    try {
      await runAdoption({
        cwd: dir, fastlaneDir: "fastlane", slug: "app", vault, asker: acceptingAsker,
        editFor: () => ({ start: 0, length: 4, replacement: "lane :beta do do do" }),
      });
      expect(await readFile(join(dir, "fastlane", "Fastfile"), "utf8")).toBe(WITH_JSON);
    } finally {
      db.close();
    }
  });
});

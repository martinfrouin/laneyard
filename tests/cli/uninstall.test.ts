import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readInventory, runUninstallCommand } from "../../src/cli/uninstall.js";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { RunStore } from "../../src/db/runs.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { tmpDir } from "../fixtures/repos.js";

interface Captured {
  code: number;
  out: string;
  err: string;
}

/** Runs the command with an answer already on standard input. */
async function run(home: string, args: string[], typed = ""): Promise<Captured> {
  let out = "";
  let err = "";
  const code = await runUninstallCommand(home, args, {
    stdin: Readable.from([`${typed}\n`]),
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
  });
  return { code, out, err };
}

/**
 * A data folder as a real installation has one: a configuration with two
 * projects, a vault key, a database holding secrets of both scopes, a signing
 * block of each scope and a run, plus something on disk for each folder.
 */
async function installed(): Promise<string> {
  const home = await tmpDir("laneyard-uninstall-");
  await mkdir(home, { recursive: true });

  await writeFile(
    join(home, "config.yml"),
    "server:\n  port: 7890\nprojects:\n  - slug: cartes\n    name: Cartes\n    git_url: git@example.com:a.git\n" +
      "  - slug: popotes\n    name: Popotes\n    git_url: git@example.com:b.git\n",
    "utf8",
  );

  const db = openDatabase(join(home, "laneyard.db"));
  const vault = await Vault.open(home, new SecretStore(db), new CredentialStore(db));
  await vault.set("cartes", "MATCH_PASSWORD", "match-password-value", true);
  await vault.set("popotes", "SENTRY_ORG", "sentry-org-value", false);
  await vault.set(null, "GITHUB_TOKEN", "github-token-value", true);
  await vault.setCredential("cartes", "android_keystore", {
    fileName: "release.jks",
    fileBytes: Buffer.from("keystore"),
    fields: { store_password: "storepass", key_alias: "release", key_password: "keypass" },
    varNames: {},
  });
  await vault.setCredential(null, "apple_asc", {
    fileName: "AuthKey.p8",
    fileBytes: Buffer.from("-----BEGIN PRIVATE KEY-----"),
    fields: { key_id: "ABC", issuer_id: "DEF" },
    varNames: {},
  });
  new RunStore(db).create({ projectSlug: "cartes", lane: "beta", platform: "ios", params: {} });
  db.close();

  await mkdir(join(home, "workspaces", "cartes"), { recursive: true });
  await writeFile(join(home, "workspaces", "cartes", "Gemfile"), "source 'x'\n", "utf8");
  await mkdir(join(home, "artifacts", "1"), { recursive: true });
  await writeFile(join(home, "artifacts", "1", "app.ipa"), "x".repeat(4096), "utf8");
  await mkdir(join(home, "logs"), { recursive: true });
  await writeFile(join(home, "logs", "1.log"), "output\n", "utf8");

  return home;
}

describe("the inventory", () => {
  it("counts blocks and secrets, keeping global ones apart from a project's", async () => {
    const inv = await readInventory(await installed());

    expect(inv.db?.vault).toEqual({
      projectSecrets: 2,
      globalSecrets: 1,
      projectBlocks: 1,
      globalBlocks: 1,
      runs: 1,
    });
    expect(inv.config?.projects).toEqual(["cartes", "popotes"]);
  });

  it("reads the real sizes and paths from disk", async () => {
    const home = await installed();
    const inv = await readInventory(home);

    const artifacts = inv.folders.find((f) => f.name === "artifacts")!;
    expect(artifacts.path).toBe(join(home, "artifacts"));
    expect(artifacts.entries).toBe(1);
    // The 4 KB file that was written, not a guess about what an artifact weighs.
    expect(artifacts.bytes).toBe(4096);
    expect(inv.bytes).toBeGreaterThan(4096);
    expect(inv.key?.path).toBe(join(home, "key"));
  });

  it("names what it did not put there, and does not count it as its own", async () => {
    const home = await installed();
    await writeFile(join(home, "notes.txt"), "mine\n", "utf8");

    const inv = await readInventory(home);
    expect(inv.strangers).toEqual(["notes.txt"]);
  });

  it("says a folder that is not there is not there", async () => {
    const inv = await readInventory(join(await tmpDir("laneyard-uninstall-"), "absent"));
    expect(inv.exists).toBe(false);
    expect(inv.bytes).toBe(0);
  });
});

describe("laneyard uninstall --dry-run", () => {
  it("writes nothing at all", async () => {
    const home = await installed();
    const before = await snapshot(home);

    const { code, out } = await run(home, ["--dry-run"]);

    expect(code).toBe(0);
    expect(await snapshot(home)).toEqual(before);
    expect(out).toContain("Nothing was removed");
  });

  it("says the vault key cannot be recovered, before anything else could happen", async () => {
    const { out } = await run(await installed(), ["--dry-run"]);

    expect(out).toContain("what cannot be undone");
    expect(out).toMatch(/vault key is the one thing here that has no other copy/);
    expect(out).toMatch(/ciphertext nobody can read/);
    expect(out).toMatch(/backup[\s\S]{0,60}database alone will not bring anything back/);
  });

  it("says plainly that a global secret shared by other projects goes too", async () => {
    const { out } = await run(await installed(), ["--dry-run"]);

    expect(out).toContain("2 project secrets");
    expect(out).toContain("1 global secret — shared by every project, removed too");
    expect(out).toContain("1 global signing block — shared by every project, removed too");
  });

  it("names the command that removes the package, and is not it", async () => {
    const { out } = await run(await installed(), ["--dry-run"]);
    expect(out).toContain("npm uninstall -g laneyard");
  });
});

describe("laneyard uninstall", () => {
  it("refuses an empty confirmation and removes nothing", async () => {
    const home = await installed();
    const before = await snapshot(home);

    const { code, err } = await run(home, [], "");

    expect(code).toBe(1);
    expect(err).toContain("Nothing was typed, so nothing was removed.");
    expect(await snapshot(home)).toEqual(before);
  });

  it("refuses a wrong confirmation and removes nothing", async () => {
    const home = await installed();
    const before = await snapshot(home);

    // `y` is exactly the reflex the typed confirmation exists to defeat.
    const { code, err } = await run(home, [], "y");

    expect(code).toBe(1);
    expect(err).toContain("That is not the path, so nothing was removed.");
    expect(await snapshot(home)).toEqual(before);
  });

  it("removes the folder once the path is typed exactly", async () => {
    const home = await installed();

    const { code, out } = await run(home, [], home);

    expect(code).toBe(0);
    expect(out).toContain("removed");
    expect(await stat(home).catch(() => null)).toBe(null);
  });

  it("keeps the folder, and what is not its own, when something else lives there", async () => {
    const home = await installed();
    await writeFile(join(home, "notes.txt"), "mine\n", "utf8");

    await run(home, [], home);

    expect(await readdir(home)).toEqual(["notes.txt"]);
  });

  it("refuses an option it does not have rather than ignoring it", async () => {
    const home = await installed();
    const { code, err } = await run(home, ["--yes"], home);

    expect(code).toBe(1);
    expect(err).toContain("Unknown option: --yes");
    expect(await stat(home).catch(() => null)).not.toBe(null);
  });

  it("says there is nothing to remove rather than failing, on a machine with no data", async () => {
    const absent = join(await tmpDir("laneyard-uninstall-"), "absent");
    const { code, out } = await run(absent, []);

    expect(code).toBe(0);
    expect(out).toContain("nothing for Laneyard to remove");
    expect(out).toContain("npm uninstall -g laneyard");
  });
});

/** Every path under a folder with its size — enough to prove nothing moved. */
async function snapshot(dir: string): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else found[child] = (await stat(child)).size;
    }
  };
  await walk(dir);
  return found;
}

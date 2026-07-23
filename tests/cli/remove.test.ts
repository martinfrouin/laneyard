import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runRemoveCommand } from "../../src/cli/remove.js";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { RunStore } from "../../src/db/runs.js";
import { SecretStore } from "../../src/db/secrets.js";
import { hashPassword } from "../../src/server/auth.js";
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
  const code = await runRemoveCommand(home, args, {
    stdin: Readable.from([`${typed}\n`]),
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { code, out, err };
}

/**
 * A data folder with two projects. `sample` carries a project secret, a project
 * signing block, a run with a log and an artifact, and a clone; `other` carries
 * a secret of its own. A global secret and a global signing block sit apart.
 */
async function installed(): Promise<{ home: string; runId: number }> {
  const home = await tmpDir("laneyard-cli-remove-");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.yml"),
    "# My configuration\nserver:\n  port: 7890\n  users:\n" +
      `    - { name: admin, role: admin, password_hash: "${hashPassword("secret")}" }\n` +
      "projects:\n" +
      "  - slug: sample\n    name: Sample\n    git_url: git@example.com:a.git\n" +
      "  - slug: other\n    name: Other\n    git_url: git@example.com:b.git\n",
    "utf8",
  );

  const db = openDatabase(join(home, "laneyard.db"));
  const vault = await Vault.open(home, new SecretStore(db), new CredentialStore(db));
  await vault.set("sample", "SAMPLE_TOKEN", "sample-token-value", true);
  await vault.set("other", "OTHER_TOKEN", "other-token-value", true);
  await vault.set(null, "SHARED_TOKEN", "shared-token-value", true);
  await vault.setCredential("sample", "android_keystore", {
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
  const runId = new RunStore(db).create({ projectSlug: "sample", lane: "beta", platform: "ios", params: {} });
  db.close();

  await mkdir(join(home, "workspaces", "sample"), { recursive: true });
  await writeFile(join(home, "workspaces", "sample", "Gemfile"), "source 'x'\n", "utf8");
  await mkdir(join(home, "artifacts", String(runId)), { recursive: true });
  await writeFile(join(home, "artifacts", String(runId), "app.ipa"), "x".repeat(2048), "utf8");
  await mkdir(join(home, "logs"), { recursive: true });
  await writeFile(join(home, "logs", `${runId}.log`), "building...\n", "utf8");

  return { home, runId };
}

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

describe("laneyard remove <slug>", () => {
  it("removes the block, the clone, the artifacts, the runs, the logs and the slug's vault rows", async () => {
    const { home, runId } = await installed();

    const { code, out } = await run(home, ["sample"], "sample");
    expect(code).toBe(0);
    expect(out).toContain("removed");

    // The block is gone; `other` stays.
    const parsed = parse(await readFile(join(home, "config.yml"), "utf8")) as { projects: { slug: string }[] };
    expect(parsed.projects.map((p) => p.slug)).toEqual(["other"]);

    // Gone from disk.
    expect(existsSync(join(home, "workspaces", "sample"))).toBe(false);
    expect(existsSync(join(home, "artifacts", String(runId)))).toBe(false);
    expect(existsSync(join(home, "logs", `${runId}.log`))).toBe(false);

    // Gone from the database, and the vault, and both scopes left intact.
    const db = openDatabase(join(home, "laneyard.db"));
    expect(new RunStore(db).get(runId)).toBeNull();
    const vault = await Vault.open(home, new SecretStore(db), new CredentialStore(db));
    expect(vault.ownedBy("sample")).toEqual({ secrets: [], credentials: [] });
    // The other project and the global rows survive.
    expect(vault.ownedBy("other").secrets.map((s) => s.key)).toEqual(["OTHER_TOKEN"]);
    expect(vault.listGlobal().map((s) => s.key)).toEqual(["SHARED_TOKEN"]);
    expect(vault.listGlobalCredentials().map((c) => c.kind)).toEqual(["apple_asc"]);
    db.close();
  });

  it("refuses an empty confirmation and removes nothing", async () => {
    const { home } = await installed();
    const before = await snapshot(home);

    const { code, err } = await run(home, ["sample"], "");
    expect(code).toBe(1);
    expect(err).toContain("Nothing was typed, so nothing was removed.");
    expect(await snapshot(home)).toEqual(before);
  });

  it("refuses a wrong confirmation and removes nothing", async () => {
    const { home } = await installed();
    const before = await snapshot(home);

    // The slug of the other project is exactly the near-miss to defend against.
    const { code, err } = await run(home, ["sample"], "other");
    expect(code).toBe(1);
    expect(err).toContain("That is not the slug, so nothing was removed.");
    expect(await snapshot(home)).toEqual(before);
  });

  it("writes nothing at all with --dry-run", async () => {
    const { home } = await installed();
    const before = await snapshot(home);

    const { code, out } = await run(home, ["sample", "--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain("what will be removed");
    expect(out).toContain("Nothing was removed");
    expect(await snapshot(home)).toEqual(before);
  });

  it("refuses an unknown slug, and names the ones it knows", async () => {
    const { home } = await installed();
    const { code, err } = await run(home, ["typo"], "typo");
    expect(code).toBe(1);
    expect(err).toMatch(/Unknown project/);
    expect(err).toContain("sample");
    expect(err).toContain("other");
  });

  it("refuses while a run of that project is in flight, and removes nothing", async () => {
    const { home, runId } = await installed();
    const db = openDatabase(join(home, "laneyard.db"));
    new RunStore(db).markRunning(runId, { branch: "main", commitSha: "abc" });
    db.close();
    const before = await snapshot(home);

    const { code, err } = await run(home, ["sample"], "sample");
    expect(code).toBe(1);
    expect(err).toMatch(/run in flight/);
    expect(await snapshot(home)).toEqual(before);
  });

  it("wants a slug", async () => {
    const { home } = await installed();
    const { code, err } = await run(home, []);
    expect(code).toBe(1);
    expect(err).toMatch(/Which project/);
  });
});

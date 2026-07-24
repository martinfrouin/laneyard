import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runResetCommand } from "../../src/cli/reset.js";
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

async function run(home: string, args: string[], typed = ""): Promise<Captured> {
  let out = "";
  let err = "";
  const code = await runResetCommand(home, args, {
    stdin: Readable.from([`${typed}\n`]),
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { code, out, err };
}

/** A data folder with accounts, two projects, vault rows, a run and some disk. */
async function installed(): Promise<string> {
  const home = await tmpDir("laneyard-cli-reset-");
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
  await vault.set("sample", "SHARED_TOKEN", "shared-token-value", true);
  new RunStore(db).create({ projectSlug: "sample", lane: "beta", platform: "ios", params: {} });
  db.close();

  await mkdir(join(home, "workspaces", "sample"), { recursive: true });
  await writeFile(join(home, "workspaces", "sample", "Gemfile"), "source 'x'\n", "utf8");
  await mkdir(join(home, "artifacts", "1"), { recursive: true });
  await writeFile(join(home, "artifacts", "1", "app.ipa"), "x".repeat(2048), "utf8");
  await mkdir(join(home, "logs"), { recursive: true });
  await writeFile(join(home, "logs", "1.log"), "building...\n", "utf8");

  return home;
}

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

describe("laneyard reset", () => {
  it("empties the projects, deletes the database, wipes the data dirs, keeps accounts and key", async () => {
    const home = await installed();
    const keyBefore = await readFile(join(home, "key"));

    const { code, out } = await run(home, [], home);
    expect(code).toBe(0);
    expect(out).toContain("reset");

    // The projects list is empty; the server block, comments and accounts survive.
    const raw = await readFile(join(home, "config.yml"), "utf8");
    expect(raw).toContain("# My configuration");
    const parsed = parse(raw) as { server: { users: { name: string }[] }; projects: unknown[] };
    expect(parsed.projects).toEqual([]);
    expect(parsed.server.users.map((u) => u.name)).toEqual(["admin"]);

    // The database and every data folder are gone.
    expect(existsSync(join(home, "laneyard.db"))).toBe(false);
    for (const dir of ["workspaces", "artifacts", "logs", "runs"]) {
      expect(existsSync(join(home, dir))).toBe(false);
    }

    // The vault key is kept, byte for byte.
    expect(existsSync(join(home, "key"))).toBe(true);
    expect(await readFile(join(home, "key"))).toEqual(keyBefore);
  });

  it("writes nothing at all with --dry-run", async () => {
    const home = await installed();
    const before = await snapshot(home);

    const { code, out } = await run(home, ["--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain("what will be wiped");
    expect(out).toContain("what will be kept");
    expect(out).toContain("Nothing was removed");
    expect(await snapshot(home)).toEqual(before);
  });

  it("refuses a wrong confirmation and removes nothing", async () => {
    const home = await installed();
    const before = await snapshot(home);

    const { code, err } = await run(home, [], "reset");
    expect(code).toBe(1);
    expect(err).toContain("That is not the path, so nothing was removed.");
    expect(await snapshot(home)).toEqual(before);
  });

  it("refuses an empty confirmation and removes nothing", async () => {
    const home = await installed();
    const before = await snapshot(home);

    const { code, err } = await run(home, [], "");
    expect(code).toBe(1);
    expect(err).toContain("Nothing was typed, so nothing was removed.");
    expect(await snapshot(home)).toEqual(before);
  });

  it("says there is nothing to reset on a machine with no data", async () => {
    const absent = join(await tmpDir("laneyard-cli-reset-"), "absent");
    const { code, out } = await run(absent, []);
    expect(code).toBe(0);
    expect(out).toContain("nothing to reset");
  });

  it("refuses an option it does not have", async () => {
    const home = await installed();
    const { code, err } = await run(home, ["--yes"], home);
    expect(code).toBe(1);
    expect(err).toContain("Unknown option: --yes");
  });
});

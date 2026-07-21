import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runSecretCommand } from "../../src/cli/secret.js";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";
import { hashPassword } from "../../src/server/auth.js";
import { Vault } from "../../src/secrets/vault.js";
import { tmpDir } from "../fixtures/repos.js";

const VALUE = "hunter2-hunter2";

async function home(): Promise<string> {
  const root = await tmpDir("laneyard-cli-secret-");
  await writeFile(
    join(root, "config.yml"),
    `server: { password_hash: "${hashPassword("x")}" }\nprojects:\n  - slug: app\n    name: App\n    git_url: git@example.com:a.git\n`,
    "utf8",
  );
  return root;
}

interface Result {
  code: number;
  out: string;
  err: string;
}

async function run(root: string, args: string[], stdin = VALUE): Promise<Result> {
  let out = "";
  let err = "";
  const code = await runSecretCommand(root, args, {
    stdin: Readable.from([Buffer.from(stdin, "utf8")]),
    interactive: false,
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { code, out, err };
}

/** Reads back what the command stored, the only way plaintext ever comes out. */
async function stored(root: string, slug: string): Promise<Record<string, string>> {
  const db = openDatabase(join(root, "laneyard.db"));
  const vault = await Vault.open(root, new SecretStore(db));
  const values = vault.resolve(slug);
  db.close();
  return values;
}

describe("laneyard secret set", () => {
  it("reads the value from standard input", async () => {
    const root = await home();
    const res = await run(root, ["set", "GITHUB_TOKEN"]);

    expect(res.code).toBe(0);
    expect(await stored(root, "app")).toEqual({ GITHUB_TOKEN: VALUE });
  });

  it("drops the newline a shell pipe adds", async () => {
    const root = await home();
    await run(root, ["set", "GITHUB_TOKEN"], `${VALUE}\n`);

    expect((await stored(root, "app"))["GITHUB_TOKEN"]).toBe(VALUE);
  });

  it("never prints the value, neither on success nor on failure", async () => {
    const root = await home();
    const ok = await run(root, ["set", "GITHUB_TOKEN"]);
    const ko = await run(root, ["set", "9BAD"]);
    const short = await run(root, ["set", "PIN"], "12");

    for (const res of [ok, ko, short]) {
      expect(res.out).not.toContain(VALUE);
      expect(res.err).not.toContain(VALUE);
      expect(res.out + res.err).not.toContain("12");
    }
    expect(ok.out).toContain("GITHUB_TOKEN");
  });

  it("refuses a name that could not become an environment variable", async () => {
    const root = await home();
    const res = await run(root, ["set", "9BAD"]);

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/not a valid environment variable name/);
    expect(await stored(root, "app")).toEqual({});
  });

  it("scopes to a project with --project", async () => {
    const root = await home();
    expect((await run(root, ["set", "MATCH_PASSWORD", "--project", "app"])).code).toBe(0);

    const db = openDatabase(join(root, "laneyard.db"));
    const store = new SecretStore(db);
    expect(store.list("app").map((s) => s.scope)).toEqual(["project"]);
    expect(store.listGlobal()).toEqual([]);
    db.close();
  });

  it("stores globally without --project, and every project sees it", async () => {
    const root = await home();
    await run(root, ["set", "GITHUB_TOKEN"]);

    const db = openDatabase(join(root, "laneyard.db"));
    expect(new SecretStore(db).listGlobal().map((s) => s.key)).toEqual(["GITHUB_TOKEN"]);
    expect(new SecretStore(db).list("app").map((s) => s.scope)).toEqual(["global"]);
    db.close();
  });

  it("refuses an unknown project rather than storing a secret nobody will see", async () => {
    const root = await home();
    const res = await run(root, ["set", "MATCH_PASSWORD", "--project", "typo"]);

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/Unknown project/);
    expect(res.err).toContain("app");
  });

  it("refuses a masked value too short to be redacted, and says why", async () => {
    const root = await home();
    const res = await run(root, ["set", "PIN"], "12");

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/at least 4 characters/);
  });

  it("accepts a short value when it is not masked", async () => {
    const root = await home();
    const res = await run(root, ["set", "PIN", "--no-mask"], "12");

    expect(res.code).toBe(0);
    expect((await stored(root, "app"))["PIN"]).toBe("12");
    const db = openDatabase(join(root, "laneyard.db"));
    expect(new SecretStore(db).listGlobal()[0]?.masked).toBe(false);
    db.close();
  });

  it("refuses a value given as an argument instead of on stdin", async () => {
    const root = await home();
    const res = await run(root, ["set", "GITHUB_TOKEN", VALUE]);

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/standard input/);
    expect(res.err).not.toContain(VALUE);
  });

  it("refuses an empty standard input", async () => {
    const root = await home();
    const res = await run(root, ["set", "GITHUB_TOKEN"], "");

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/standard input/);
  });

  it("explains itself when stdin is a terminal", async () => {
    const root = await home();
    let err = "";
    const code = await runSecretCommand(root, ["set", "GITHUB_TOKEN"], {
      stdin: Readable.from([]),
      interactive: true,
      out: () => {},
      err: (t) => (err += t),
    });

    expect(code).toBe(1);
    expect(err).toMatch(/shell history/);
  });

  it("rejects an unknown subcommand with the usage", async () => {
    const root = await home();
    const res = await run(root, ["list"]);

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/laneyard secret set/);
  });
});

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import { buildApp } from "../../src/server/app.js";
import { ConfigStore } from "../../src/config/store.js";
import { CacheStore } from "../../src/db/cache.js";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { SecretStore } from "../../src/db/secrets.js";
import { LaneReader } from "../../src/sidecar/lanes.js";
import type { Invoke } from "../../src/sidecar/bridge.js";
import { Vault } from "../../src/secrets/vault.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const exec = promisify(execFile);

/**
 * Every case here clones a real repository and shells out to a real git, as
 * the git-layer's own tests do. That is the point, and it is also why five
 * seconds is not enough when the whole suite runs at once.
 */
const SLOW = 60_000;

const INITIAL_FASTFILE = "lane :beta do\nend\n";

/**
 * A stand-in for the Ruby sidecar that actually reads the Fastfile it's
 * pointed at, rather than returning a canned answer. It "parses" by counting
 * balanced `do`/`end` pairs, and lists one lane per `lane :name do`. That's
 * enough to make the cache-invalidation and verification-failure tests
 * exercise the real thing: a write that changes the file must change what
 * this returns, and a write that breaks it must make this fail.
 */
const fakeInvoke: Invoke = async (command, cwd, fastlaneDir) => {
  if (command !== "lanes") return { ok: false, error: `unexpected command: ${command}` };
  const content = await readFile(join(cwd, fastlaneDir, "Fastfile"), "utf8");
  const opens = (content.match(/\bdo\b/g) ?? []).length;
  const ends = (content.match(/\bend\b/g) ?? []).length;
  if (opens !== ends || opens === 0) {
    return { ok: false, error: "SyntaxError: unbalanced do/end" };
  }
  const names = [...content.matchAll(/lane\s+:(\w+)\s+do/g)].map((m) => m[1] as string);
  return {
    ok: true,
    lanes: names.map((name) => ({ name, platform: null, description: "", private: false })),
  };
};

async function harness(fastlaneDir?: string) {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": INITIAL_FASTFILE });
  const root = await tmpDir("laneyard-fastfile-");
  const configPath = join(root, "config.yml");
  await writeFile(
    configPath,
    `
server:
  users:
    - { name: admin, role: admin, password_hash: "${hashPassword("secret")}" }
projects:
  - slug: sample
    name: Sample
    git_url: ${origin}
${fastlaneDir === undefined ? "" : `    fastlane_dir: "${fastlaneDir}"\n`}`,
    "utf8",
  );

  const config = new ConfigStore(configPath);
  await config.load();
  const db = openDatabase(":memory:");
  const cache = new CacheStore(db);

  const app = await buildApp({
    config,
    db,
    root,
    lanes: (slug, workspacePath, fastlaneDir) =>
      new LaneReader(cache, fakeInvoke).read(slug, workspacePath, fastlaneDir),
    uses: async () => ({ lanes: [], imports: false }),
    vault: await Vault.open(root, new SecretStore(db), new CredentialStore(db)),
  });

  return { app, root, db, origin };
}

async function login(app: Awaited<ReturnType<typeof harness>>["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { name: "admin", password: "secret" },
  });
  return res.cookies[0]!.value;
}

describe("fastfile API", () => {
  it("refuses without a session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/fastfile" });
    expect(res.statusCode).toBe(401);
  }, SLOW);

  it("404s on an unknown project", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/fastfile", cookies });
    expect(res.statusCode).toBe(404);
  }, SLOW);

  it("reads the content, whether the workspace is dirty, and the diff", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/fastfile", cookies });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: INITIAL_FASTFILE, dirty: false, diff: "" });
  }, SLOW);

  it("explains, rather than ENOENTs, when the configured dir is not in the clone", async () => {
    // The failure that started this: a `fastlane_dir` detected in a working
    // copy that never reached the remote — a stray `app copie/` macOS made,
    // uncommitted, or gitignored — so the clone Laneyard builds from has no
    // such folder. The read used to surface a raw ENOENT; it must now name the
    // directory and say what to do.
    const { app } = await harness("app copie/fastlane");
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/fastfile", cookies });

    expect(res.statusCode).toBe(503);
    const { error } = res.json() as { error: string };
    expect(error).not.toMatch(/ENOENT/);
    expect(error).toContain("app copie/fastlane");
    expect(error).toMatch(/clone of the remote/);
    expect(error).toMatch(/config\.yml/);
  }, SLOW);

  it("writes the content byte for byte and it shows up dirty", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const edited = "lane :beta do\n  puts 1\nend\n";

    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/fastfile",
      cookies,
      payload: { content: edited },
    });
    expect(put.statusCode).toBe(204);

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/fastfile", cookies });
    const body = res.json() as { content: string; dirty: boolean; diff: string };
    expect(body.content).toBe(edited);
    expect(body.dirty).toBe(true);
    expect(body.diff).toContain("puts 1");
  }, SLOW);

  it("rejects a write that fails verification and restores the previous content", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const broken = "lane :beta do  # never closed";

    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/fastfile",
      cookies,
      payload: { content: broken },
    });
    expect(put.statusCode).toBe(400);
    expect((put.json() as { error: string }).error).toMatch(/unbalanced/i);

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/fastfile", cookies });
    const body = res.json() as { content: string; dirty: boolean };
    expect(body.content).toBe(INITIAL_FASTFILE);
    expect(body.dirty).toBe(false);
  }, SLOW);

  it("refuses to write while a run is in flight for that project", async () => {
    const { app, db } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const runs = new RunStore(db);
    const id = runs.create({ projectSlug: "sample", lane: "beta", platform: null, params: {} });
    runs.setStatus(id, "running");

    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/fastfile",
      cookies,
      payload: { content: "lane :beta do\n  puts 2\nend\n" },
    });

    expect(res.statusCode).toBe(409);

    // And it was genuinely refused: the file is untouched.
    const after = await app.inject({ method: "GET", url: "/api/projects/sample/fastfile", cookies });
    expect((after.json() as { content: string }).content).toBe(INITIAL_FASTFILE);
  }, SLOW);

  it("allows the write once the in-flight run has finished", async () => {
    const { app, db } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const runs = new RunStore(db);
    const id = runs.create({ projectSlug: "sample", lane: "beta", platform: null, params: {} });
    runs.setStatus(id, "running");
    runs.finish(id, { status: "success", exitCode: 0, errorSummary: null });

    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/fastfile",
      cookies,
      payload: { content: "lane :beta do\n  puts 2\nend\n" },
    });

    expect(res.statusCode).toBe(204);
  }, SLOW);

  it("no longer serves a stale lane list once the Fastfile has been rewritten", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const before = await app.inject({ method: "GET", url: "/api/projects/sample/lanes", cookies });
    expect(before.json()).toMatchObject([{ name: "beta" }]);

    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/fastfile",
      cookies,
      payload: { content: "lane :beta do\nend\n\nlane :gamma do\nend\n" },
    });
    expect(put.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/api/projects/sample/lanes", cookies });
    expect((after.json() as { name: string }[]).map((l) => l.name).sort()).toEqual(["beta", "gamma"]);
  }, SLOW);

  it("reports the changed files and their diff", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/fastfile",
      cookies,
      payload: { content: "lane :beta do\n  puts 3\nend\n" },
    });

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/changes", cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: string[]; diff: string };
    expect(body.files).toEqual([join("fastlane", "Fastfile")]);
    expect(body.diff).toContain("puts 3");
  }, SLOW);

  it("commits exactly the changed files, not everything in the workspace", async () => {
    const { app, root } = await harness();
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/fastfile",
      cookies,
      payload: { content: "lane :beta do\n  puts 4\nend\n" },
    });

    // A build leaving a file behind, the way fastlane's own README rewrite or
    // an artifact would. It must not ride along into the commit.
    const workspacePath = join(root, "workspaces", "sample");
    await writeFile(join(workspacePath, "left-by-a-build.txt"), "not meant to be committed", "utf8");

    const commit = await app.inject({
      method: "POST",
      url: "/api/projects/sample/commit",
      cookies,
      payload: { message: "Update the beta lane" },
    });
    expect(commit.statusCode).toBe(204);

    const { stdout } = await exec(
      "git",
      ["show", "--name-only", "--pretty=format:", "HEAD"],
      { cwd: workspacePath },
    );
    expect(stdout.trim().split("\n")).toEqual([join("fastlane", "Fastfile")]);

    const after = await app.inject({ method: "GET", url: "/api/projects/sample/changes", cookies });
    expect((after.json() as { files: string[] }).files).toEqual([]);
  }, SLOW);

  it("400s a commit with no message", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/sample/commit",
      cookies,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  }, SLOW);

  it("pushes committed changes to the remote", async () => {
    const { app, origin, root } = await harness();
    const cookies = { laneyard_session: await login(app) };
    // Same accommodation as the git-layer tests: the fixture "remote" is a
    // non-bare repo with `main` checked out, which real remotes never are.
    await exec("git", ["config", "receive.denyCurrentBranch", "updateInstead"], { cwd: origin });

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/fastfile",
      cookies,
      payload: { content: "lane :beta do\n  puts 5\nend\n" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/sample/commit",
      cookies,
      payload: { message: "Update the beta lane" },
    });

    const push = await app.inject({ method: "POST", url: "/api/projects/sample/push", cookies });
    expect(push.statusCode).toBe(204);

    const workspacePath = join(root, "workspaces", "sample");
    const local = await readFile(join(workspacePath, "fastlane", "Fastfile"), "utf8");
    const remote = await readFile(join(origin, "fastlane", "Fastfile"), "utf8");
    expect(remote).toBe(local);
  }, SLOW);

  it("400s a push that git rejects, with git's own message", async () => {
    const { app, origin } = await harness();
    const cookies = { laneyard_session: await login(app) };

    // The remote moves on without us: our push is now behind.
    await writeFile(join(origin, "fastlane", "Fastfile"), "lane :beta do\n  puts 'elsewhere'\nend\n", "utf8");
    await exec("git", ["add", "-A"], { cwd: origin });
    await exec("git", ["commit", "-q", "-m", "edited elsewhere"], { cwd: origin });

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/fastfile",
      cookies,
      payload: { content: "lane :beta do\n  puts 6\nend\n" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/sample/commit",
      cookies,
      payload: { message: "Update the beta lane" },
    });

    const push = await app.inject({ method: "POST", url: "/api/projects/sample/push", cookies });
    expect(push.statusCode).toBe(400);
    expect((push.json() as { error: string }).error).toMatch(/rejected/i);
  }, SLOW);
});

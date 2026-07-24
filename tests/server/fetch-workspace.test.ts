import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import { buildApp } from "../../src/server/app.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { RunStore } from "../../src/db/runs.js";
import { Workspace } from "../../src/git/workspace.js";
import { commitTo, makeOriginRepo, tmpDir } from "../fixtures/repos.js";

/**
 * The clone only ever moved at the start of a run.
 *
 * Every screen that reads the repository — the lanes, the checklist, the names
 * a lane is missing — goes through `ensureCloned`, which does nothing when the
 * directory is already there. So a project whose first run failed early kept
 * answering from that first commit, for days, with nothing on screen saying so:
 * a variable stored in the meantime, or a Fastfile that stopped reading it, was
 * invisible until someone managed a run that got far enough to fetch.
 */
async function harness(files: Record<string, string>) {
  const origin = await makeOriginRepo(files);
  const root = await tmpDir("laneyard-fetch-");
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
`,
    "utf8",
  );

  const config = new ConfigStore(configPath);
  await config.load();
  const db = openDatabase(":memory:");

  const app = await buildApp({
    config,
    db,
    root,
    lanes: async () => [],
    uses: async () => ({ lanes: [], imports: false }),
    vault: await Vault.open(root, new SecretStore(db), new CredentialStore(db)),
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { name: "admin", password: "secret" },
  });

  return {
    app,
    origin,
    runs: new RunStore(db),
    workspace: join(root, "workspaces", "sample"),
    cookies: { laneyard_session: res.cookies[0]!.value },
  };
}

describe("POST /api/projects/:slug/fetch", () => {
  it("brings the clone up to the remote and answers with the commit", async () => {
    const { app, origin, workspace, cookies } = await harness({
      "fastlane/Fastfile": "lane :beta do\nend\n",
    });

    // The clone as every screen makes it: present, and never fetched since.
    await app.inject({ method: "GET", url: "/api/projects/sample/lanes", cookies });
    const before = await new Workspace(workspace, origin).headSha();

    const sha = await commitTo(origin, "fastlane/Fastfile", "lane :beta do\nend\nlane :alpha do\nend\n");

    const res = await app.inject({ method: "POST", url: "/api/projects/sample/fetch", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ commitSha: sha, branch: "main" });

    expect(await new Workspace(workspace, origin).headSha()).not.toBe(before);
  }, 60_000);

  it("clones a project that has never been cloned", async () => {
    // The ordinary state between `laneyard setup` and a first run: pressing
    // refresh must be a way in, not a refusal that reads like a broken button.
    const { app, cookies } = await harness({ "fastlane/Fastfile": "lane :beta do\nend\n" });

    const res = await app.inject({ method: "POST", url: "/api/projects/sample/fetch", cookies });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { commitSha: string }).commitSha).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it("refuses to move a workspace holding a commit that was never pushed", async () => {
    // The Fastfile tab commits without pushing, deliberately. Moving the branch
    // onto origin's would leave that commit reachable only from the reflog —
    // silently, in the one place the interface offers to write for you.
    const { app, origin, workspace, cookies } = await harness({
      "fastlane/Fastfile": "lane :beta do\nend\n",
    });
    await app.inject({ method: "GET", url: "/api/projects/sample/lanes", cookies });

    const clone = new Workspace(workspace, origin);
    await writeFile(join(workspace, "fastlane", "Fastfile"), "lane :local do\nend\n", "utf8");
    await clone.commit("local only", ["fastlane/Fastfile"]);
    const local = await clone.headSha();

    const res = await app.inject({ method: "POST", url: "/api/projects/sample/fetch", cookies });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/not (been )?pushed|unpushed/i);
    // The refusal is the whole point: the commit is still there.
    expect(await clone.headSha()).toBe(local);
  }, 60_000);

  it("refuses while a run of that project is in flight", async () => {
    const { app, runs, cookies } = await harness({ "fastlane/Fastfile": "lane :beta do\nend\n" });
    app.queue.close();

    // A run that has begun is reading the very files this would move under it.
    runs.markRunning(runs.create({ projectSlug: "sample", lane: "beta", platform: null, params: {} }), {
      branch: "main",
      commitSha: "0".repeat(40),
    });

    const res = await app.inject({ method: "POST", url: "/api/projects/sample/fetch", cookies });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/run/i);
  }, 60_000);

  it("answers 404 for a project that is not declared", async () => {
    const { app, cookies } = await harness({ "fastlane/Fastfile": "lane :beta do\nend\n" });
    const res = await app.inject({ method: "POST", url: "/api/projects/nope/fetch", cookies });
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it("needs a session, like everything else under a project", async () => {
    const { app } = await harness({ "fastlane/Fastfile": "lane :beta do\nend\n" });
    const res = await app.inject({ method: "POST", url: "/api/projects/sample/fetch" });
    expect(res.statusCode).toBe(401);
  }, 60_000);
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { removeProjectFromConfig } from "../../src/cli/setup.js";
import { buildApp } from "../../src/server/app.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { SecretStore } from "../../src/db/secrets.js";
import { hashPassword } from "../../src/server/auth.js";
import { requiresAdmin } from "../../src/server/permissions.js";
import { Vault } from "../../src/secrets/vault.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const CONFIG = (origin: string) => `# My Laneyard configuration
server:
  port: 7890
  password_hash: "${hashPassword("secret")}"   # server password

projects:
  - slug: sample
    name: Sample
    git_url: ${origin}
  - slug: other
    name: Other
    git_url: ${origin}
`;

async function harness() {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
  const root = await tmpDir("laneyard-remove-");
  const configPath = join(root, "config.yml");
  await writeFile(configPath, CONFIG(origin), "utf8");

  const config = new ConfigStore(configPath);
  await config.load();
  const db = openDatabase(":memory:");

  const vault = await Vault.open(root, new SecretStore(db), new CredentialStore(db));
  const app = await buildApp({
    config,
    db,
    root,
    lanes: async () => [{ name: "beta", platform: "ios", description: "Beta", private: false }],
    uses: async () => ({ lanes: [{ lane: "beta", actions: [] }], imports: false }),
    vault,
  });

  // Nothing may start on its own: these tests decide which runs are in flight.
  app.queue.close();

  return { app, root, configPath, vault, runs: new RunStore(db) };
}

/** A project secret, a global secret, and one signing block of each scope. */
async function fillVault(vault: Vault): Promise<void> {
  await vault.set("sample", "SAMPLE_TOKEN", "sample-token-value", true);
  await vault.set("sample", "SAMPLE_ISSUER", "issuer-value", false);
  await vault.set(null, "SHARED_TOKEN", "shared-token-value", true);
  await vault.setCredential("sample", "android_keystore", {
    fileName: "release.jks",
    fileBytes: Buffer.from("keystore-bytes"),
    fields: { store_password: "storepass", key_alias: "release", key_password: "keypass" },
    varNames: {},
  });
  await vault.setCredential(null, "play_service_account", {
    fileName: "play.json",
    fileBytes: Buffer.from("{}"),
    fields: {},
    varNames: {},
  });
}

async function login(app: Awaited<ReturnType<typeof harness>>["app"]): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "secret" } });
  return res.cookies[0]!.value;
}

describe("removeProjectFromConfig", () => {
  it("removes only that project and keeps the file's comments", async () => {
    const dir = await tmpDir("laneyard-remove-yaml-");
    const path = join(dir, "config.yml");
    await writeFile(path, CONFIG("git@example.com:a.git"), "utf8");

    expect(await removeProjectFromConfig(path, "sample")).toBe(true);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("# My Laneyard configuration");
    expect(raw).toContain("# server password");
    const parsed = parse(raw) as { projects: { slug: string }[] };
    expect(parsed.projects.map((p) => p.slug)).toEqual(["other"]);
  });

  it("leaves long lines it never touched exactly as they were", async () => {
    const dir = await tmpDir("laneyard-remove-yaml-");
    const path = join(dir, "config.yml");
    const content = CONFIG("git@example.com:a.git");
    await writeFile(path, content, "utf8");

    await removeProjectFromConfig(path, "sample");

    // The password hash is well past eighty columns, and YAML's default width
    // would fold it across two lines — the file coming back out changed on a
    // line nobody asked about. It still parses, which is exactly why it would
    // go unnoticed until someone opened the file and did not recognise it.
    const hash = /password_hash: "([^"]+)"/.exec(content)![1]!;
    expect(await readFile(path, "utf8")).toContain(`password_hash: "${hash}"`);
  });

  it("reports that an unknown slug removed nothing", async () => {
    const dir = await tmpDir("laneyard-remove-yaml-");
    const path = join(dir, "config.yml");
    // Written once and compared against itself: the hash carries a random salt.
    const content = CONFIG("git@example.com:a.git");
    await writeFile(path, content, "utf8");

    expect(await removeProjectFromConfig(path, "absent")).toBe(false);
    expect(await readFile(path, "utf8")).toBe(content);
  });
});

describe("DELETE /api/projects/:slug", () => {
  it("takes the project out of the configuration and out of the listing", async () => {
    const { app, configPath } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({ method: "DELETE", url: "/api/projects/sample", cookies });
    expect(res.statusCode).toBe(200);

    const parsed = parse(await readFile(configPath, "utf8")) as { projects: { slug: string }[] };
    expect(parsed.projects.map((p) => p.slug)).toEqual(["other"]);

    const listing = await app.inject({ method: "GET", url: "/api/projects", cookies });
    expect((listing.json() as { slug: string }[]).map((p) => p.slug)).toEqual(["other"]);
  });

  it("404s on a project this machine does not know", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "DELETE", url: "/api/projects/absent", cookies });
    expect(res.statusCode).toBe(404);
  });

  it("refuses while a run of that project is in flight, and writes nothing", async () => {
    const { app, configPath, runs } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const before = await readFile(configPath, "utf8");

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    const { id } = created.json() as { id: number };
    // Queued is not in flight: only a run that has begun holds the workspace.
    runs.markRunning(id, { branch: "main", commitSha: "abc" });

    const res = await app.inject({ method: "DELETE", url: "/api/projects/sample", cookies });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/run/i);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("keeps the run history reachable by its own URL", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    const { id } = created.json() as { id: number };

    const removed = await app.inject({ method: "DELETE", url: "/api/projects/sample", cookies });
    expect((removed.json() as { runsKept: number }).runsKept).toBe(1);

    const run = await app.inject({ method: "GET", url: `/api/runs/${id}`, cookies });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ id, projectSlug: "sample" });
  });

  it("names the paths it leaves on disk, and leaves them there", async () => {
    const { app, root } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const workspace = join(root, "workspaces", "sample");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "Gemfile"), "source 'x'\n", "utf8");

    const res = await app.inject({ method: "DELETE", url: "/api/projects/sample", cookies });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { leftOnDisk: string[] }).leftOnDisk).toContain(workspace);

    // Named, not deleted: the whole point of naming them is that they are still there.
    expect(await readFile(join(workspace, "Gemfile"), "utf8")).toBe("source 'x'\n");
  });

  it("does not name a workspace that was never cloned", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "DELETE", url: "/api/projects/sample", cookies });
    expect((res.json() as { leftOnDisk: string[] }).leftOnDisk).toEqual([]);
  });

  it("counts what stays in the vault, and leaves it there", async () => {
    const { app, vault } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await fillVault(vault);

    const res = await app.inject({ method: "DELETE", url: "/api/projects/sample", cookies });
    expect(res.json()).toMatchObject({
      vaultKept: {
        secrets: 2,
        signingBlocks: 1,
        // Shared by every project, so named apart rather than folded in.
        globalSecrets: 1,
        globalSigningBlocks: 1,
      },
    });

    // Counted, not deleted: the whole point of counting them is that they are
    // still there, and still readable by a project set up under the same name.
    expect(vault.ownedBy("sample").secrets.map((s) => s.key)).toEqual(["SAMPLE_ISSUER", "SAMPLE_TOKEN"]);
    expect(vault.resolveCredential("sample", "android_keystore")?.fileName).toBe("release.jks");
  });

  it("reports zero for a project that never had a secret", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "DELETE", url: "/api/projects/sample", cookies });
    expect(res.json()).toMatchObject({
      vaultKept: { secrets: 0, signingBlocks: 0, globalSecrets: 0, globalSigningBlocks: 0 },
    });
  });
});

describe("DELETE /api/projects/:slug/vault", () => {
  it("removes this project's secrets and blocks, and only those", async () => {
    const { app, vault } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await fillVault(vault);
    await app.inject({ method: "DELETE", url: "/api/projects/sample", cookies });

    const res = await app.inject({ method: "DELETE", url: "/api/projects/sample/vault", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slug: "sample", secretsRemoved: 2, signingBlocksRemoved: 1 });

    expect(vault.ownedBy("sample")).toEqual({ secrets: [], credentials: [] });
    // The global rows are every project's, and survive one project going away.
    expect(vault.listGlobal().map((s) => s.key)).toEqual(["SHARED_TOKEN"]);
    expect(vault.listGlobalCredentials().map((c) => c.kind)).toEqual(["play_service_account"]);
    // The other project's own rows were never in scope either.
    expect(vault.list("other").map((s) => s.key)).toEqual(["SHARED_TOKEN"]);
  });

  it("refuses while the slug is still a project on this machine", async () => {
    const { app, vault } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await fillVault(vault);

    const res = await app.inject({ method: "DELETE", url: "/api/projects/sample/vault", cookies });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/still a project/i);
    expect(vault.ownedBy("sample").secrets).toHaveLength(2);
  });

  it("is an admin's action, like every other route into the vault", () => {
    // It inherits the restriction rather than declaring its own: the table
    // matches on a path prefix, and `DELETE /api/projects/:slug` already covers
    // everything below it. Asserted anyway, because "inherits" is exactly the
    // kind of thing that stops being true when a table is reordered.
    expect(requiresAdmin("DELETE", "/api/projects/sample/vault")).toBe(true);
  });
});

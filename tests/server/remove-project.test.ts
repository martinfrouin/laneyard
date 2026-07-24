import { existsSync } from "node:fs";
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
import { Vault } from "../../src/secrets/vault.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const CONFIG = (origin: string) => `# My Laneyard configuration
server:
  port: 7890
  users:
    - { name: admin, role: admin, password_hash: "${hashPassword("secret")}" }   # server password

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

/** Two secrets and a signing block for the project, and a second project's own. */
async function fillVault(vault: Vault): Promise<void> {
  await vault.set("sample", "SAMPLE_TOKEN", "sample-token-value", true);
  await vault.set("sample", "SAMPLE_ISSUER", "issuer-value", false);
  await vault.set("bystander", "OTHER_TOKEN", "other-token-value", true);
  await vault.setCredential("sample", "android_keystore", {
    fileName: "release.jks",
    fileBytes: Buffer.from("keystore-bytes"),
    fields: { store_password: "storepass", key_alias: "release", key_password: "keypass" },
    varNames: {},
  });
  await vault.setCredential("bystander", "play_service_account", {
    fileName: "play.json",
    fileBytes: Buffer.from("{}"),
    fields: {},
    varNames: {},
  });
}

async function login(app: Awaited<ReturnType<typeof harness>>["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { name: "admin", password: "secret" },
  });
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

/** Queues a run, and writes it a log and an artifact folder as a real one would. */
async function makeRun(
  app: Awaited<ReturnType<typeof harness>>["app"],
  root: string,
  cookies: Record<string, string>,
): Promise<number> {
  const created = await app.inject({
    method: "POST",
    url: "/api/projects/sample/runs",
    cookies,
    payload: { lane: "beta", params: {} },
  });
  const { id } = created.json() as { id: number };

  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(join(root, "logs", `${id}.log`), "building...\n", "utf8");
  const artifacts = join(root, "artifacts", String(id));
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "app.ipa"), "bytes", "utf8");
  return id;
}

const del = (slug: string, confirm?: string): string =>
  confirm === undefined ? `/api/projects/${slug}` : `/api/projects/${slug}?confirm=${confirm}`;

describe("DELETE /api/projects/:slug", () => {
  it("404s on a project this machine does not know", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "DELETE", url: del("absent", "absent"), cookies });
    expect(res.statusCode).toBe(404);
  });

  it("refuses without the slug typed back, and removes nothing", async () => {
    const { app, configPath, root, vault, runs } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await fillVault(vault);
    const before = await readFile(configPath, "utf8");
    const id = await makeRun(app, root, cookies);

    // No confirmation at all, then a confirmation that is not the slug.
    for (const url of [del("sample"), del("sample", "wrong")]) {
      const res = await app.inject({ method: "DELETE", url, cookies });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/nothing was removed/i);
    }

    // Everything is exactly where it was.
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(runs.get(id)).not.toBeNull();
    expect(existsSync(join(root, "artifacts", String(id)))).toBe(true);
    expect(vault.list("sample")).toHaveLength(2);
  });

  it("refuses while a run of that project is in flight, and removes nothing", async () => {
    const { app, configPath, vault, runs } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await fillVault(vault);
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

    // Confirmed, so it is the run in flight and not the confirmation that refuses.
    const res = await app.inject({ method: "DELETE", url: del("sample", "sample"), cookies });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/run/i);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(runs.get(id)).not.toBeNull();
    expect(vault.list("sample")).toHaveLength(2);
  });

  it("removes the config block and takes the project out of the listing", async () => {
    const { app, configPath } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({ method: "DELETE", url: del("sample", "sample"), cookies });
    expect(res.statusCode).toBe(200);

    const parsed = parse(await readFile(configPath, "utf8")) as { projects: { slug: string }[] };
    expect(parsed.projects.map((p) => p.slug)).toEqual(["other"]);

    const listing = await app.inject({ method: "GET", url: "/api/projects", cookies });
    expect((listing.json() as { slug: string }[]).map((p) => p.slug)).toEqual(["other"]);
  });

  it("removes the clone, the artifacts, the run history and its logs", async () => {
    const { app, root, runs } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const workspace = join(root, "workspaces", "sample");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "Gemfile"), "source 'x'\n", "utf8");

    const id = await makeRun(app, root, cookies);
    const artifacts = join(root, "artifacts", String(id));
    const log = join(root, "logs", `${id}.log`);

    const res = await app.inject({ method: "DELETE", url: del("sample", "sample"), cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      removed: { runs: 1, artifacts: 1, workspace: true },
    });

    // Gone from disk.
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(artifacts)).toBe(false);
    expect(existsSync(log)).toBe(false);

    // Gone from the database, and no longer reachable at its own URL.
    expect(runs.get(id)).toBeNull();
    const run = await app.inject({ method: "GET", url: `/api/runs/${id}`, cookies });
    expect(run.statusCode).toBe(404);
  });

  it("forgets this project's vault rows and touches no other project's", async () => {
    const { app, vault } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await fillVault(vault);

    const res = await app.inject({ method: "DELETE", url: del("sample", "sample"), cookies });
    expect(res.json()).toMatchObject({ removed: { secrets: 2, signingBlocks: 1 } });

    // The project's own rows are gone.
    expect(vault.list("sample")).toEqual([]);
    expect(vault.listCredentials("sample")).toEqual([]);
    // Another project's are exactly where they were.
    expect(vault.list("bystander").map((s) => s.key)).toEqual(["OTHER_TOKEN"]);
    expect(vault.listCredentials("bystander").map((c) => c.kind)).toEqual(["play_service_account"]);
    expect(vault.resolve("bystander")).toMatchObject({ OTHER_TOKEN: "other-token-value" });
  });

  it("reports zero for a project with nothing behind it", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "DELETE", url: del("sample", "sample"), cookies });
    expect(res.json()).toMatchObject({
      removed: { runs: 0, artifacts: 0, workspace: false, secrets: 0, signingBlocks: 0 },
    });
  });

  it("no longer answers on the old /vault route", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "DELETE", url: "/api/projects/sample/vault", cookies });
    expect(res.statusCode).toBe(404);
  });
});

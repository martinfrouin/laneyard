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
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

async function harness() {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
  const root = await tmpDir("laneyard-secrets-");
  const configPath = join(root, "config.yml");
  await writeFile(
    configPath,
    `
server:
  password_hash: "${hashPassword("secret")}"
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
    lanes: async () => [{ name: "beta", platform: "ios", description: "Beta", private: false }],
    uses: async () => [{ lane: "beta", actions: [] }],
    vault: await Vault.open(root, new SecretStore(db), new CredentialStore(db)),
  });

  return { app, root };
}

async function login(app: Awaited<ReturnType<typeof harness>>["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "secret" },
  });
  return res.cookies[0]!.value;
}

describe("secrets API", () => {
  it("refuses without a session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/secrets" });
    expect(res.statusCode).toBe(401);
  });

  it("lists names and scopes, never values", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/API_TOKEN",
      cookies,
      payload: { value: "super-secret-value" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets",
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject([{ key: "API_TOKEN", masked: true, scope: "project" }]);
    // No trace of the plaintext or of any ciphertext-shaped field anywhere in the body.
    expect(res.body).not.toContain("super-secret-value");
    expect(res.body).not.toMatch(/value/i);
  });

  it("stores a secret and lists it", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/API_TOKEN",
      cookies,
      payload: { value: "super-secret-value" },
    });
    expect(put.statusCode).toBe(204);

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets",
      cookies,
    });
    expect(res.json()).toMatchObject([{ key: "API_TOKEN" }]);
  });

  it("rejects a key that is not a valid environment variable name", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/not-a-key",
      cookies,
      payload: { value: "super-secret-value" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a masked value too short to redact, rather than pretending", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/SHORT",
      cookies,
      payload: { value: "abc" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/characters/);
  });

  it("overwrites an existing secret", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/API_TOKEN",
      cookies,
      payload: { value: "first-value-1234" },
    });
    const put2 = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/API_TOKEN",
      cookies,
      payload: { value: "second-value-5678" },
    });
    expect(put2.statusCode).toBe(204);

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets",
      cookies,
    });
    expect(res.json()).toMatchObject([{ key: "API_TOKEN" }]);
    expect((res.json() as unknown[]).length).toBe(1);
  });

  it("deletes a secret", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/API_TOKEN",
      cookies,
      payload: { value: "super-secret-value" },
    });

    const del = await app.inject({
      method: "DELETE",
      url: "/api/projects/sample/secrets/API_TOKEN",
      cookies,
    });
    expect(del.statusCode).toBe(204);

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets",
      cookies,
    });
    expect(res.json()).toEqual([]);
  });

  it("404s on deleting one that does not exist", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/sample/secrets/NOPE",
      cookies,
    });
    expect(res.statusCode).toBe(404);
  });

  it("keeps global secrets on their own route", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const put = await app.inject({
      method: "PUT",
      url: "/api/secrets/GLOBAL_TOKEN",
      cookies,
      payload: { value: "global-secret-value" },
    });
    expect(put.statusCode).toBe(204);

    const global = await app.inject({ method: "GET", url: "/api/secrets", cookies });
    expect(global.json()).toMatchObject([{ key: "GLOBAL_TOKEN", scope: "global" }]);

    // A project's own listing sees it too — project scope wins, but a global
    // secret still applies where no project-level override exists.
    const projectList = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets",
      cookies,
    });
    expect(projectList.json()).toMatchObject([{ key: "GLOBAL_TOKEN", scope: "global" }]);
  });
});

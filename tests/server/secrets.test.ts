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

async function harness(options: { uses?: () => Promise<unknown> } = {}) {
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
    uses: (options.uses ?? (async () => ({ lanes: [{ lane: "beta", actions: [] }], imports: false }))) as never,
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

/**
 * The vault has been write-only since it was written: the server never sent a
 * value back, so no browser ever held one. That stays true for anything anyone
 * called a secret.
 *
 * What changed is the recognition that not everything stored here is one. An
 * `APP_VERSION` or a `SENTRY_ORG` is an identifier, and being unable to check
 * what an import stored makes the import something you take on faith. The line
 * is the user's own and already existed: `masked` means "keep this out of the
 * logs".
 */
describe("revealing a value", () => {
  const store = async (
    app: Awaited<ReturnType<typeof harness>>["app"],
    cookies: Record<string, string>,
    key: string,
    value: string,
    masked: boolean,
  ) =>
    app.inject({
      method: "PUT",
      url: `/api/projects/sample/secrets/${key}`,
      cookies,
      payload: { value, masked },
    });

  it("hands back a value that was never declared secret", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await store(app, cookies, "APP_VERSION", "1.4.0", false);

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets/APP_VERSION/value",
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBe("1.4.0");
  });

  // The whole point. A masked value is never returned, whoever asks.
  it("refuses a value that is kept out of the logs", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await store(app, cookies, "MATCH_PASSWORD", "a long enough passphrase", true);

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets/MATCH_PASSWORD/value",
      cookies,
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain("a long enough passphrase");
  });

  it("answers 404 for a secret that is not there", async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets/NOPE/value",
      cookies: { laneyard_session: await login(app) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("needs a session, like everything else under a project", async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets/APP_VERSION/value",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("turning redaction on and off", () => {
  /**
   * The circle this breaks: reading a value means first declaring it not
   * secret, and declaring that by storing it again would mean typing the value
   * you were trying to read.
   */
  it("unmasks without touching the value, which then reads back", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/SENTRY_ORG",
      cookies,
      payload: { value: "acme-mobile", masked: true },
    });

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/projects/sample/secrets/SENTRY_ORG",
      cookies,
      payload: { masked: false },
    });
    expect(patched.statusCode).toBe(204);

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets/SENTRY_ORG/value",
      cookies,
    });
    expect(res.json().value).toBe("acme-mobile");
  });

  it("masks again, and the value stops coming back", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/SENTRY_ORG",
      cookies,
      payload: { value: "acme-mobile", masked: false },
    });

    await app.inject({
      method: "PATCH",
      url: "/api/projects/sample/secrets/SENTRY_ORG",
      cookies,
      payload: { masked: true },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets/SENTRY_ORG/value",
      cookies,
    });
    expect(res.statusCode).toBe(409);
  });

  // The same refusal as on the way in: accepting it would leave someone
  // believing they are protected while the value stays legible in every log.
  it("refuses to mask a value too short to be redacted", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/SHORT",
      cookies,
      payload: { value: "1.4", masked: false },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/sample/secrets/SHORT",
      cookies,
      payload: { masked: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses anything that is not a boolean", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/A_KEY",
      cookies,
      payload: { value: "a long enough value", masked: true },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/sample/secrets/A_KEY",
      cookies,
      payload: { masked: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * The names a project needs, so the screen can put the form up with them
 * already in it. Someone arriving has just been told eight variables are
 * missing; retyping those eight by hand is a chore where one typo stores a
 * secret nothing will ever read.
 *
 * Names only — never a value, from anywhere. The file that holds the real ones
 * is the file that does not reach a clone, which is the problem being reported
 * rather than a source to read.
 */
describe("GET /api/projects/:slug/required-secrets", () => {
  it("names what a lane reads and has not got", async () => {
    const { app } = await harness({
      uses: async () => ({
        lanes: [{ lane: "beta", actions: [], env: ["ASC_KEY_ID", "APP_VERSION"] }],
        imports: false,
      }),
    });
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/required-secrets",
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().required).toEqual(["APP_VERSION", "ASC_KEY_ID"]);
    expect(res.json().missing).toEqual(["APP_VERSION", "ASC_KEY_ID"]);
  });

  it("drops one from missing once it is stored", async () => {
    const { app } = await harness({
      uses: async () => ({
        lanes: [{ lane: "beta", actions: [], env: ["ASC_KEY_ID", "APP_VERSION"] }],
        imports: false,
      }),
    });
    const cookies = { laneyard_session: await login(app) };
    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/ASC_KEY_ID",
      cookies,
      payload: { value: "a long enough value", masked: true },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/required-secrets",
      cookies,
    });
    expect(res.json().required).toContain("ASC_KEY_ID");
    expect(res.json().missing).toEqual(["APP_VERSION"]);
  });

  it("offers nothing rather than failing when the lanes cannot be read", async () => {
    const { app } = await harness({
      uses: async () => {
        throw new Error("no Ruby");
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/required-secrets",
      cookies: { laneyard_session: await login(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().missing).toEqual([]);
  });

  it("is 404 for a project that is not declared", async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/nope/required-secrets",
      cookies: { laneyard_session: await login(app) },
    });
    expect(res.statusCode).toBe(404);
  });
});

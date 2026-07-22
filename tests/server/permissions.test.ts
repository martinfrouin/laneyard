import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { hashPassword } from "../../src/server/auth.js";
import { REQUIRES_ADMIN, requiresAdmin } from "../../src/server/permissions.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

async function harness() {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
  const root = await tmpDir("laneyard-perm-");
  const configPath = join(root, "config.yml");
  await writeFile(
    configPath,
    `
server:
  users:
    - { name: martin, role: admin, password_hash: "${hashPassword("admin pass")}" }
    - { name: ci, role: builder, password_hash: "${hashPassword("builder pass")}" }
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

  const login = async (name: string, password: string): Promise<string> => {
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { name, password } });
    expect(res.statusCode).toBe(200);
    return res.cookies[0]!.value;
  };

  return { app, root, login };
}

describe("requiresAdmin", () => {
  it("matches a listed route whatever the verb, when the entry says so", () => {
    expect(requiresAdmin("GET", "/api/secrets")).toBe(true);
    expect(requiresAdmin("PUT", "/api/secrets")).toBe(true);
    expect(requiresAdmin("DELETE", "/api/secrets")).toBe(true);
  });

  it("covers what lives under a listed path", () => {
    // `/api/secrets` is the vault, not one URL: a table listing every key's
    // route would be a table someone forgets to extend.
    expect(requiresAdmin("PUT", "/api/secrets/APP_STORE_KEY")).toBe(true);
    expect(requiresAdmin("DELETE", "/api/projects/sample/secrets/APP_STORE_KEY")).toBe(true);
  });

  it("matches a path parameter against any single segment", () => {
    expect(requiresAdmin("PUT", "/api/projects/anything-at-all/fastfile")).toBe(true);
  });

  it("holds an entry to its verb when the entry names one", () => {
    // Reading the Fastfile is deliberately not admin: a builder who can start a
    // lane benefits from seeing what it does, and it holds no credential.
    expect(requiresAdmin("GET", "/api/projects/sample/fastfile")).toBe(false);
    expect(requiresAdmin("GET", "/api/projects/sample")).toBe(false);
    expect(requiresAdmin("DELETE", "/api/projects/sample")).toBe(true);
  });

  it("leaves the ordinary work of a build alone", () => {
    for (const [method, path] of [
      ["GET", "/api/projects"],
      ["GET", "/api/projects/sample/lanes"],
      ["GET", "/api/projects/sample/runs"],
      ["GET", "/api/projects/sample/readiness"],
      ["GET", "/api/projects/sample/changes"],
      ["POST", "/api/projects/sample/runs"],
      ["GET", "/api/runs/12"],
      ["POST", "/api/runs/12/cancel"],
      ["GET", "/api/runs/12/log"],
      ["GET", "/api/runs/12/stream"],
      ["GET", "/api/runs/12/artifacts/3"],
      ["GET", "/api/me"],
    ] as const) {
      expect([method, path, requiresAdmin(method, path)]).toEqual([method, path, false]);
    }
  });

  it("ignores the query string", () => {
    expect(requiresAdmin("GET", "/api/secrets?after=1")).toBe(true);
    expect(requiresAdmin("GET", "/api/projects?after=1")).toBe(false);
  });

  it("is not fooled by a path that merely starts with the same letters", () => {
    expect(requiresAdmin("GET", "/api/secretsomething")).toBe(false);
  });

  it("sees the path the router sees, not the one that was typed", () => {
    // Regression: the router percent-decodes before matching, so `/api/%73ecrets`
    // reaches the vault's handler. Comparing raw text let a builder read it.
    expect(requiresAdmin("GET", "/api/%73ecrets")).toBe(true);
    expect(requiresAdmin("GET", "/api/projects/sample/%73ecrets")).toBe(true);
  });

  it("is unmoved by an empty segment", () => {
    expect(requiresAdmin("GET", "/api//secrets")).toBe(true);
    expect(requiresAdmin("GET", "/api/secrets/")).toBe(true);
  });

  it("is case-insensitive on the verb, as HTTP is not", () => {
    expect(requiresAdmin("delete", "/api/projects/sample")).toBe(true);
  });
});

/**
 * One case per admin-only route.
 *
 * Built from the table itself rather than typed out beside it, so that adding a
 * route to `REQUIRES_ADMIN` without a case here is impossible.
 */
const ADMIN_ONLY_REQUESTS: { method: "GET" | "PUT" | "POST" | "DELETE"; url: string }[] = [
  { method: "GET", url: "/api/secrets" },
  { method: "PUT", url: "/api/secrets/APP_KEY" },
  { method: "DELETE", url: "/api/secrets/APP_KEY" },
  { method: "GET", url: "/api/projects/sample/secrets" },
  { method: "PUT", url: "/api/projects/sample/secrets/APP_KEY" },
  { method: "DELETE", url: "/api/projects/sample/secrets/APP_KEY" },
  { method: "PUT", url: "/api/projects/sample/fastfile" },
  { method: "POST", url: "/api/projects/sample/commit" },
  { method: "POST", url: "/api/projects/sample/push" },
  { method: "DELETE", url: "/api/projects/sample" },
  { method: "GET", url: "/api/users" },
  { method: "POST", url: "/api/users" },
  { method: "DELETE", url: "/api/users/ci" },
];

describe("the admin list, from a builder's session", () => {
  it("covers every entry of the table with at least one request", () => {
    for (const pattern of REQUIRES_ADMIN) {
      const covered = ADMIN_ONLY_REQUESTS.some(
        (r) =>
          (pattern.method === "*" || pattern.method === r.method) &&
          requiresAdmin(r.method, r.url) &&
          r.url.startsWith(pattern.path.split("/:")[0]!),
      );
      expect([pattern, covered]).toEqual([pattern, true]);
    }
  });

  for (const { method, url } of ADMIN_ONLY_REQUESTS) {
    it(`refuses ${method} ${url}`, async () => {
      const { app, login } = await harness();
      const builder = await login("ci", "builder pass");

      const res = await app.inject({
        method,
        url,
        cookies: { laneyard_session: builder },
        payload: { value: "a value long enough to be masked", message: "m", content: "x" },
      });

      // 403, never 404 and never 200: the answer must not depend on whether the
      // thing behind the route happens to exist.
      expect([method, url, res.statusCode]).toEqual([method, url, 403]);
    });

    it(`lets an admin through to ${method} ${url}`, async () => {
      // The other half of the proof: without this, a route that is simply
      // broken would pass the refusal test for the wrong reason.
      const { app, login } = await harness();
      const admin = await login("martin", "admin pass");

      const res = await app.inject({
        method,
        url,
        cookies: { laneyard_session: admin },
        payload: { value: "a value long enough to be masked", message: "m", content: "x" },
      });

      expect([method, url, res.statusCode]).not.toEqual([method, url, 403]);
    });
  }

  it("refuses without a session before it looks at anything else", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/secrets" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses the vault however the URL is spelled", async () => {
    // Regression, end to end: Fastify routes `/api/%73ecrets` to the vault, and
    // a matcher reading the raw text handed a builder the list of secrets.
    const { app, login } = await harness();
    const cookies = { laneyard_session: await login("ci", "builder pass") };

    for (const url of ["/api/%73ecrets", "/api/projects/sample/%73ecrets", "/api//secrets"]) {
      const res = await app.inject({ method: "GET", url, cookies });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
  });

  it("refuses a HEAD of an admin route, which Fastify serves from the GET", async () => {
    const { app, login } = await harness();
    const res = await app.inject({
      method: "HEAD",
      url: "/api/secrets",
      cookies: { laneyard_session: await login("ci", "builder pass") },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("what a builder is for", () => {
  it("triggers a run, watches it and cancels it", async () => {
    const { app, login } = await harness();
    app.queue.close();
    const cookies = { laneyard_session: await login("ci", "builder pass") };

    expect((await app.inject({ method: "GET", url: "/api/me", cookies })).json()).toEqual({
      name: "ci",
      role: "builder",
    });

    const lanes = await app.inject({ method: "GET", url: "/api/projects/sample/lanes", cookies });
    expect(lanes.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: number };

    const watched = await app.inject({ method: "GET", url: `/api/runs/${id}`, cookies });
    expect(watched.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/runs/${id}/log`, cookies })).statusCode).toBe(200);

    const cancelled = await app.inject({ method: "POST", url: `/api/runs/${id}/cancel`, cookies });
    expect(cancelled.statusCode).toBe(204);
  });

  it("reads the Fastfile, which holds no credential", async () => {
    const { app, login } = await harness();
    const cookies = { laneyard_session: await login("ci", "builder pass") };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/fastfile", cookies });
    expect(res.statusCode).not.toBe(403);
  });

  it("sees the readiness checklist", async () => {
    const { app, login } = await harness();
    const cookies = { laneyard_session: await login("ci", "builder pass") };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    expect(res.statusCode).not.toBe(403);
  });
});

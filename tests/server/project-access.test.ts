import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildApp } from "../../src/server/app.js";
import { hashPassword } from "../../src/server/auth.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const ADMIN_PASSWORD = "admin pass";
const BUILDER_PASSWORD = "builder pass";

/**
 * Two projects, one admin, and a builder whose grant line is handed in — the
 * whole variable this feature turns on. `grant` is dropped straight into the
 * account entry, so it can be `projects: [alpha]`, `projects: []`, or nothing at
 * all (the old config that reaches everything).
 */
async function harness(grant: string) {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
  const root = await tmpDir("laneyard-access-");
  const configPath = join(root, "config.yml");
  await writeFile(
    configPath,
    `
server:
  users:
    - { name: martin, role: admin, password_hash: "${hashPassword(ADMIN_PASSWORD)}" }
    - { name: ci, role: builder, password_hash: "${hashPassword(BUILDER_PASSWORD)}"${grant} }
projects:
  - slug: alpha
    name: Alpha
    git_url: ${origin}
  - slug: bravo
    name: Bravo
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
    uses: async () => ({ lanes: [{ lane: "beta", actions: [] }], imports: false }),
    vault: await Vault.open(root, new SecretStore(db), new CredentialStore(db)),
  });
  // Nothing starts on its own: these tests decide what exists.
  app.queue.close();

  const login = async (name: string, password: string): Promise<string> => {
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { name, password } });
    return res.cookies[0]!.value;
  };

  return { app, root, configPath, config, runs: new RunStore(db), login };
}

const slugs = (body: string): string[] =>
  (JSON.parse(body) as { slug: string }[]).map((p) => p.slug);

describe("GET /api/projects, filtered per account", () => {
  it("serves a builder only the slugs it is granted", async () => {
    const { app, login } = await harness(", projects: [alpha]");
    const cookies = { laneyard_session: await login("ci", BUILDER_PASSWORD) };
    const res = await app.inject({ method: "GET", url: "/api/projects", cookies });
    expect(slugs(res.body)).toEqual(["alpha"]);
  });

  it("serves an admin every project", async () => {
    const { app, login } = await harness(", projects: [alpha]");
    const cookies = { laneyard_session: await login("martin", ADMIN_PASSWORD) };
    const res = await app.inject({ method: "GET", url: "/api/projects", cookies });
    expect(slugs(res.body)).toEqual(["alpha", "bravo"]);
  });

  it("serves a builder with no grant list everything — back-compat", async () => {
    const { app, login } = await harness("");
    const cookies = { laneyard_session: await login("ci", BUILDER_PASSWORD) };
    const res = await app.inject({ method: "GET", url: "/api/projects", cookies });
    expect(slugs(res.body)).toEqual(["alpha", "bravo"]);
  });

  it("serves a builder with an empty grant list nothing", async () => {
    const { app, login } = await harness(", projects: []");
    const cookies = { laneyard_session: await login("ci", BUILDER_PASSWORD) };
    const res = await app.inject({ method: "GET", url: "/api/projects", cookies });
    expect(slugs(res.body)).toEqual([]);
  });
});

describe("a project a builder may not reach is invisible, not locked", () => {
  it("404s an ungranted project on every builder verb and every route under it", async () => {
    const { app, login } = await harness(", projects: [alpha]");
    const cookies = { laneyard_session: await login("ci", BUILDER_PASSWORD) };

    // The routes a builder is otherwise allowed, under the ungranted project.
    const requests: { method: "GET" | "POST"; url: string }[] = [
      { method: "GET", url: "/api/projects/bravo/lanes" },
      { method: "GET", url: "/api/projects/bravo/runs" },
      { method: "GET", url: "/api/projects/bravo/readiness" },
      { method: "GET", url: "/api/projects/bravo/changes" },
      { method: "GET", url: "/api/projects/bravo/fastfile" },
      { method: "POST", url: "/api/projects/bravo/runs" },
    ];

    for (const { method, url } of requests) {
      const res = await app.inject({ method, url, cookies, payload: { lane: "beta", params: {} } });
      // 404, never 403: a 403 would confirm the project exists. And the body is
      // the very one an unknown project gives, so the two cannot be told apart.
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
      expect((res.json() as { error: string }).error).toBe("Unknown project");
    }
  });

  it("serves the granted project the same builder reaches", async () => {
    const { app, login } = await harness(", projects: [alpha]");
    const cookies = { laneyard_session: await login("ci", BUILDER_PASSWORD) };
    // A route that needs no clone: the run listing of a project that exists.
    const res = await app.inject({ method: "GET", url: "/api/projects/alpha/runs", cookies });
    expect(res.statusCode).toBe(200);
  });

  it("404s an ungranted project's run addressed by its id", async () => {
    const { app, login, runs } = await harness(", projects: [alpha]");
    const cookies = { laneyard_session: await login("ci", BUILDER_PASSWORD) };

    const reachable = runs.create({ projectSlug: "alpha", lane: "beta", platform: null, params: {} });
    const hidden = runs.create({ projectSlug: "bravo", lane: "beta", platform: null, params: {} });

    // The run of the granted project is served; the one behind the ungranted
    // project is 404 with the unknown-project body — the run id never leaks that
    // a project by that name exists.
    for (const url of [`/api/runs/${hidden}`, `/api/runs/${hidden}/log`]) {
      const res = await app.inject({ method: "GET", url, cookies });
      expect([url, res.statusCode]).toEqual([url, 404]);
      expect((res.json() as { error: string }).error).toBe("Unknown project");
    }

    const ok = await app.inject({ method: "GET", url: `/api/runs/${reachable}`, cookies });
    expect(ok.statusCode).toBe(200);
  });

  it("lets an admin reach every project's routes", async () => {
    const { app, login } = await harness(", projects: [alpha]");
    const cookies = { laneyard_session: await login("martin", ADMIN_PASSWORD) };
    const res = await app.inject({ method: "GET", url: "/api/projects/bravo/runs", cookies });
    expect(res.statusCode).toBe(200);
  });
});

describe("PUT /api/users/:name/projects", () => {
  it("writes the grant and takes effect on the next request", async () => {
    const { app, login, configPath } = await harness(", projects: []");

    // The builder starts reaching nothing.
    const builder = { laneyard_session: await login("ci", BUILDER_PASSWORD) };
    expect(slugs((await app.inject({ method: "GET", url: "/api/projects", cookies: builder })).body)).toEqual([]);

    // The admin grants one project.
    const admin = { laneyard_session: await login("martin", ADMIN_PASSWORD) };
    const put = await app.inject({
      method: "PUT",
      url: "/api/users/ci/projects",
      cookies: admin,
      payload: { projects: ["alpha"] },
    });
    expect(put.statusCode).toBe(200);

    // config.yml carries it, and the very next request the builder makes sees it
    // — the hook re-reads config, so no re-login is needed.
    const written = parse(await readFile(configPath, "utf8")) as {
      server: { users: { name: string; projects?: string[] }[] };
    };
    expect(written.server.users.find((u) => u.name === "ci")!.projects).toEqual(["alpha"]);
    expect(slugs((await app.inject({ method: "GET", url: "/api/projects", cookies: builder })).body)).toEqual([
      "alpha",
    ]);
  });

  it("refuses a builder — the grant route is the admin's", async () => {
    const { app, login } = await harness(", projects: [alpha]");
    const res = await app.inject({
      method: "PUT",
      url: "/api/users/ci/projects",
      cookies: { laneyard_session: await login("ci", BUILDER_PASSWORD) },
      payload: { projects: ["alpha", "bravo"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses to set a list on an admin, whose reach is not a list", async () => {
    const { app, login } = await harness(", projects: [alpha]");
    const res = await app.inject({
      method: "PUT",
      url: "/api/users/martin/projects",
      cookies: { laneyard_session: await login("martin", ADMIN_PASSWORD) },
      payload: { projects: ["alpha"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s an account nobody carries", async () => {
    const { app, login } = await harness(", projects: [alpha]");
    const res = await app.inject({
      method: "PUT",
      url: "/api/users/nobody/projects",
      cookies: { laneyard_session: await login("martin", ADMIN_PASSWORD) },
      payload: { projects: ["alpha"] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a body that is not a list of slugs", async () => {
    const { app, login } = await harness(", projects: []");
    const admin = { laneyard_session: await login("martin", ADMIN_PASSWORD) };
    for (const projects of [undefined, "alpha", [1], ["NOT A SLUG"]]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/users/ci/projects",
        cookies: admin,
        payload: { projects },
      });
      expect([projects, res.statusCode]).toEqual([projects, 400]);
    }
  });
});

describe("account creation writes an empty grant", () => {
  it("starts a new builder reaching nothing", async () => {
    const { app, login, configPath } = await harness(", projects: [alpha]");
    const admin = { laneyard_session: await login("martin", ADMIN_PASSWORD) };

    await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: admin,
      payload: { name: "renaud", role: "builder", password: "a long enough password" },
    });

    const written = parse(await readFile(configPath, "utf8")) as {
      server: { users: { name: string; projects?: string[] }[] };
    };
    expect(written.server.users.find((u) => u.name === "renaud")!.projects).toEqual([]);

    // And in effect: the new builder logs in and reaches no project.
    const cookies = { laneyard_session: await login("renaud", "a long enough password") };
    expect(slugs((await app.inject({ method: "GET", url: "/api/projects", cookies })).body)).toEqual([]);
  });

  it("preserves a builder's grant across a password change", async () => {
    // Replacing an account changes the role and the password; a grant it carried
    // has nothing to do with either and must survive.
    const { app, login, configPath } = await harness(", projects: [alpha]");
    const admin = { laneyard_session: await login("martin", ADMIN_PASSWORD) };

    await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: admin,
      payload: { name: "ci", role: "builder", password: "a different long password" },
    });

    const written = parse(await readFile(configPath, "utf8")) as {
      server: { users: { name: string; projects?: string[] }[] };
    };
    expect(written.server.users.find((u) => u.name === "ci")!.projects).toEqual(["alpha"]);
  });
});

describe("deleting a project strips its slug from every account", () => {
  it("removes the grant when the project it points at is removed", async () => {
    const { app, login, configPath } = await harness(", projects: [alpha, bravo]");
    const admin = { laneyard_session: await login("martin", ADMIN_PASSWORD) };

    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/bravo?confirm=bravo",
      cookies: admin,
    });
    expect(res.statusCode).toBe(200);

    const written = parse(await readFile(configPath, "utf8")) as {
      server: { users: { name: string; projects?: string[] }[] };
    };
    // The dead grant is gone; the live one stays.
    expect(written.server.users.find((u) => u.name === "ci")!.projects).toEqual(["alpha"]);
  });
});

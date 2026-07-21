import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import { buildApp } from "../../src/server/app.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

async function harness() {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
  const root = await tmpDir("laneyard-api-");
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

  const app = await buildApp({
    config,
    db: openDatabase(":memory:"),
    root,
    lanes: async () => [{ name: "beta", platform: "ios", description: "Beta", private: false }],
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

describe("API", () => {
  it("refuses access without a session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a wrong password", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("lists the projects once logged in", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      cookies: { laneyard_session: session },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ slug: "sample", name: "Sample" }]);
  });

  it("returns a project's lanes", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/lanes",
      cookies: { laneyard_session: session },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ name: "beta", platform: "ios" }]);
  });

  it("responds 404 for a project absent from the configuration", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/unknown/lanes",
      cookies: { laneyard_session: session },
    });
    expect(res.statusCode).toBe(404);
  });

  it("creates a queued run and makes it viewable", async () => {
    const { app } = await harness();
    const session = await login(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies: { laneyard_session: session },
      payload: { lane: "beta", platform: "ios", params: {} },
    });

    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: number };

    const fetched = await app.inject({
      method: "GET",
      url: `/api/runs/${id}`,
      cookies: { laneyard_session: session },
    });
    expect(fetched.json()).toMatchObject({ id, lane: "beta", projectSlug: "sample" });
  });

  it("refuses to launch an unknown lane", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies: { laneyard_session: session },
      payload: { lane: "does-not-exist", params: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a second run while the previous one occupies the workspace", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const first = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    expect(first.statusCode).toBe(201);

    // The first run is still active: two runs would share the same git clone.
    const second = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });

    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toMatch(/in progress/);
  });
});

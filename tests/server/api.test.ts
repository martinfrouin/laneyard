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
  const db = openDatabase(":memory:");

  const app = await buildApp({
    config,
    db,
    root,
    lanes: async () => [{ name: "beta", platform: "ios", description: "Beta", private: false }],
    uses: async () => ({ lanes: [{ lane: "beta", actions: [] }], imports: false }),
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

  it("still accepts the legacy password-only form, so a 0.2 install upgrades in place", async () => {
    // This harness's config.yml is the old single-password form, unedited.
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "secret" } });
    expect(res.statusCode).toBe(200);
    expect(res.cookies[0]!.value.length).toBeGreaterThan(0);
  });

  it("accepts that same account by its name", async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { name: "admin", password: "secret" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("says who is signed in", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      cookies: { laneyard_session: session },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "admin", role: "admin" });
  });

  it("refuses to say who is signed in without a session", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
  });

  it("answers an unknown name exactly as it answers a wrong password", async () => {
    // A different status or a different message would turn the login form into
    // a way to find out which accounts exist.
    const { app } = await harness();
    const unknown = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { name: "nobody", password: "secret" },
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { name: "admin", password: "nope" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json()).toEqual(wrong.json());
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

  it("queues a second run instead of refusing it", async () => {
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

    const second = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });

    expect(second.statusCode).toBe(201);
    expect((second.json() as { queuePosition: number }).queuePosition).toBeGreaterThan(0);
  });

  it("reports a run's place in line", async () => {
    const { app } = await harness();
    // Closed before anything is queued: with the worker asleep, the positions
    // are what the test asserts and not what a race happened to leave behind.
    app.queue.close();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const ids: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/sample/runs",
        cookies,
        payload: { lane: "beta", params: {} },
      });
      ids.push((res.json() as { id: number }).id);
    }

    const third = await app.inject({ method: "GET", url: `/api/runs/${ids[2]}`, cookies });
    expect(third.json()).toMatchObject({ status: "queued", queuePosition: 3 });
  });

  it("cancels a queued run on the spot", async () => {
    const { app } = await harness();
    app.queue.close();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    const { id } = created.json() as { id: number };

    // Nothing to signal: a run that never started is finished synchronously,
    // so the status is already `cancelled` when the response comes back.
    const cancelled = await app.inject({ method: "POST", url: `/api/runs/${id}/cancel`, cookies });
    expect(cancelled.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: `/api/runs/${id}`, cookies });
    expect(after.json()).toMatchObject({ status: "cancelled", queuePosition: null });
  });

  it("404s cancelling a run that does not exist", async () => {
    const { app } = await harness();
    app.queue.close();
    const session = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/runs/4242/cancel",
      cookies: { laneyard_session: session },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s cancelling a run that already finished", async () => {
    const { app } = await harness();
    app.queue.close();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    const { id } = created.json() as { id: number };

    expect((await app.inject({ method: "POST", url: `/api/runs/${id}/cancel`, cookies })).statusCode).toBe(204);

    const again = await app.inject({ method: "POST", url: `/api/runs/${id}/cancel`, cookies });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: string }).error).toMatch(/finished/i);
  });
});

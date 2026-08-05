import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { buildApp } from "../../src/server/app.js";
import { hashPassword } from "../../src/server/auth.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

async function harness() {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
  const root = await tmpDir("laneyard-build-number-");
  const configPath = join(root, "config.yml");
  await writeFile(
    configPath,
    `
server:
  users:
    - { name: admin, role: admin, password_hash: "${hashPassword("secret")}" }
    - { name: lea, role: builder, password_hash: "${hashPassword("secret")}" }
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

  return { app };
}

async function login(app: Awaited<ReturnType<typeof harness>>["app"], name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { name, password: "secret" } });
  return res.cookies[0]!.value;
}

describe("build number", () => {
  it("starts at 1 for a project that has never run", async () => {
    const { app } = await harness();
    const session = await login(app, "admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/build-number",
      cookies: { laneyard_session: session },
    });
    expect(res.json()).toEqual({ next: 1 });
  });

  it("sets where the counter carries on from", async () => {
    const { app } = await harness();
    const session = await login(app, "admin");
    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/build-number",
      cookies: { laneyard_session: session },
      payload: { next: 57 },
    });
    expect(put.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/build-number",
      cookies: { laneyard_session: session },
    });
    expect(res.json()).toEqual({ next: 57 });
  });

  it("refuses anything that is not a whole number of 1 or more", async () => {
    const { app } = await harness();
    const session = await login(app, "admin");
    for (const next of [0, -3, 1.5, "57", null]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/projects/sample/build-number",
        cookies: { laneyard_session: session },
        payload: { next },
      });
      expect(res.statusCode, `next: ${JSON.stringify(next)}`).toBe(400);
    }
  });

  it("lets a builder read it but not set it", async () => {
    const { app } = await harness();
    const session = await login(app, "lea");

    const read = await app.inject({
      method: "GET",
      url: "/api/projects/sample/build-number",
      cookies: { laneyard_session: session },
    });
    expect(read.statusCode).toBe(200);

    const write = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/build-number",
      cookies: { laneyard_session: session },
      payload: { next: 57 },
    });
    expect(write.statusCode).toBe(403);
  });

  it("answers 404 for a project that is not configured", async () => {
    const { app } = await harness();
    const session = await login(app, "admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/nope/build-number",
      cookies: { laneyard_session: session },
    });
    expect(res.statusCode).toBe(404);
  });
});

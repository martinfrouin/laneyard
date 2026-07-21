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
  - slug: popotes
    name: Popotes
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
  it("refuse l'accès sans session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("refuse un mauvais mot de passe", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "faux" } });
    expect(res.statusCode).toBe(401);
  });

  it("liste les projets une fois connecté", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      cookies: { laneyard_session: session },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ slug: "popotes", name: "Popotes" }]);
  });

  it("renvoie les lanes d'un projet", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/popotes/lanes",
      cookies: { laneyard_session: session },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ name: "beta", platform: "ios" }]);
  });

  it("répond 404 pour un projet absent de la configuration", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/inconnu/lanes",
      cookies: { laneyard_session: session },
    });
    expect(res.statusCode).toBe(404);
  });

  it("crée un run en attente et le rend consultable", async () => {
    const { app } = await harness();
    const session = await login(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/popotes/runs",
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
    expect(fetched.json()).toMatchObject({ id, lane: "beta", projectSlug: "popotes" });
  });

  it("refuse de lancer une lane inconnue", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/popotes/runs",
      cookies: { laneyard_session: session },
      payload: { lane: "nexiste-pas", params: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuse un second run tant que le précédent occupe le workspace", async () => {
    const { app } = await harness();
    const session = await login(app);
    const cookies = { laneyard_session: session };

    const first = await app.inject({
      method: "POST",
      url: "/api/projects/popotes/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    expect(first.statusCode).toBe(201);

    // Le premier run est encore actif : deux runs partageraient le même clone git.
    const second = await app.inject({
      method: "POST",
      url: "/api/projects/popotes/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });

    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toMatch(/en cours/);
  });
});

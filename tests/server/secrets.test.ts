import { readFile, writeFile } from "node:fs/promises";
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
  users:
    - { name: admin, role: admin, password_hash: "${hashPassword("secret")}" }
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
    payload: { name: "admin", password: "secret" },
  });
  return res.cookies[0]!.value;
}

describe("secrets API", () => {
  it("refuses without a session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/secrets" });
    expect(res.statusCode).toBe(401);
  });

  it("lists names, never values", async () => {
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
    expect(body).toMatchObject([{ key: "API_TOKEN", masked: true }]);
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

  it("has no way in that does not name a project", async () => {
    // There used to be an unscoped route for each of these, and a row stored
    // through it was read by every project. A request that names no project now
    // reaches nothing at all.
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    for (const [method, url] of [
      ["GET", "/api/secrets"],
      ["PUT", "/api/secrets/GLOBAL_TOKEN"],
      ["DELETE", "/api/secrets/GLOBAL_TOKEN"],
    ] as const) {
      const res = await app.inject({ method, url, cookies, payload: { value: "global-secret-value" } });
      expect(res.statusCode).toBe(404);
    }
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

  // The listing draws the same line the single-value route draws, so a screen
  // never has to ask twice for something it is allowed to show once.
  it("carries the values that were never declared secret, and only those", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await store(app, cookies, "APP_VERSION", "1.4.0", false);
    await store(app, cookies, "MATCH_PASSWORD", "a long enough passphrase", true);

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/secrets", cookies });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { key: string; value?: string }[];
    expect(body.find((s) => s.key === "APP_VERSION")?.value).toBe("1.4.0");
    // Absent, not empty: a masked value is never sent back, whoever asks.
    expect(body.find((s) => s.key === "MATCH_PASSWORD")).not.toHaveProperty("value");
    expect(res.body).not.toContain("a long enough passphrase");
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

  // Asked for by name, one at a time, and answered — including for a value kept
  // out of the logs. What `masked` decides is what a run prints and what the
  // listing carries, not whether its owner may ever look at it again.
  it("hands back a value that is kept out of the logs, when asked for by name", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await store(app, cookies, "MATCH_PASSWORD", "a long enough passphrase", true);

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/secrets/MATCH_PASSWORD/value",
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBe("a long enough passphrase");

    // And still nowhere near the listing: opening the tab reveals nothing.
    const list = await app.inject({ method: "GET", url: "/api/projects/sample/secrets", cookies });
    expect(list.body).not.toContain("a long enough passphrase");
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

  it("masks again, and the value leaves the listing", async () => {
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

    // Out of the logs, and out of the listing — which is what the tick box
    // decides. Asked for by name it still answers: see the reveal tests above.
    const list = await app.inject({ method: "GET", url: "/api/projects/sample/secrets", cookies });
    expect(list.body).not.toContain("acme-mobile");
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

  it("does not ask for a name a signing block already supplies", async () => {
    const { app } = await harness({
      uses: async () => ({
        lanes: [{ lane: "beta", actions: [], env: ["SUPPLY_JSON_KEY"] }],
        imports: false,
      }),
    });
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/play_service_account",
      cookies,
      payload: {
        fileName: "play.json",
        fileBase64: Buffer.from('{"type":"service_account"}').toString("base64"),
        fields: {},
        varNames: { path: "SUPPLY_JSON_KEY" },
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/required-secrets",
      cookies,
    });
    expect(res.json().required).toEqual(["SUPPLY_JSON_KEY"]);
    expect(res.json().missing).toEqual([]);
  });

  /**
   * The two consumers of one computation, asked the same question.
   *
   * They are the screen and the sentence about the screen: a checklist telling
   * someone to store `SUPPLY_JSON_KEY` while the form beside it has stopped
   * offering the box is worse than either answer alone, because it is the one
   * situation where no reading of the interface is right.
   */
  it("agrees with the readiness checklist about what is supplied", async () => {
    const { app } = await harness({
      uses: async () => ({
        lanes: [{ lane: "beta", actions: [], env: ["SUPPLY_JSON_KEY", "SENTRY_AUTH_TOKEN"] }],
        imports: false,
      }),
    });
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/play_service_account",
      cookies,
      payload: {
        fileName: "play.json",
        fileBase64: Buffer.from('{"type":"service_account"}').toString("base64"),
        fields: {},
        varNames: { path: "SUPPLY_JSON_KEY" },
      },
    });

    const form = await app.inject({
      method: "GET",
      url: "/api/projects/sample/required-secrets",
      cookies,
    });
    const checklist = await app.inject({
      method: "GET",
      url: "/api/projects/sample/readiness",
      cookies,
    });

    const environment = (checklist.json().sections as { checks: { id: string; detail: string }[] }[])
      .flatMap((s) => s.checks)
      .find((c) => c.id === "environment")!;

    // One name is missing and one is not, and both say so of the same one.
    expect(form.json().missing).toEqual(["SENTRY_AUTH_TOKEN"]);
    expect(environment.detail).toMatch(/SENTRY_AUTH_TOKEN/);
    expect(environment.detail).not.toMatch(/SUPPLY_JSON_KEY/);
  }, 60_000);
});

describe("the environment file", () => {
  it("stores the flag on the way in, and reports it in the listing", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/API_URL",
      cookies,
      payload: { value: "https://api.example.com", masked: false, inEnvFile: true },
    });
    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/MATCH_PASSWORD",
      cookies,
      payload: { value: "correct-horse-battery" },
    });

    const listed = (await app.inject({ method: "GET", url: "/api/projects/sample/secrets", cookies })).json();
    expect(listed).toEqual([
      { key: "API_URL", masked: false, inEnvFile: true, value: "https://api.example.com" },
      { key: "MATCH_PASSWORD", masked: true, inEnvFile: false },
    ]);
  });

  it("flips one flag without disturbing the other", async () => {
    // They answer different questions about the same row — what a run prints,
    // and what a build reads from disk. A request about one must not decide the
    // other by omission.
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const url = "/api/projects/sample/secrets/API_URL";
    await app.inject({ method: "PUT", url, cookies, payload: { value: "https://api.example.com" } });

    const flag = async (
      payload: { masked?: boolean; inEnvFile?: boolean },
    ): Promise<{ masked: boolean; inEnvFile: boolean }> => {
      await app.inject({ method: "PATCH", url, cookies, payload });
      const listed = (await app.inject({
        method: "GET",
        url: "/api/projects/sample/secrets",
        cookies,
      })).json() as { masked: boolean; inEnvFile: boolean }[];
      return listed[0]!;
    };

    expect(await flag({ inEnvFile: true })).toMatchObject({ masked: true, inEnvFile: true });
    expect(await flag({ masked: false })).toMatchObject({ masked: false, inEnvFile: true });
    expect(await flag({ inEnvFile: false })).toMatchObject({ masked: false, inEnvFile: false });
  });

  it("refuses a request that flips nothing", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/API_URL",
      cookies,
      payload: { value: "https://api.example.com" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/sample/secrets/API_URL",
      cookies,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("shows the file that will be written, and never a masked value in it", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    for (const [key, value, masked] of [
      ["API_URL", "https://api.example.com", false],
      ["SENTRY_DSN", "https://abc@sentry.example/42", true],
      ["MATCH_PASSWORD", "correct-horse-battery", true],
    ] as const) {
      await app.inject({
        method: "PUT",
        url: `/api/projects/sample/secrets/${key}`,
        cookies,
        payload: { value, masked, inEnvFile: key !== "MATCH_PASSWORD" },
      });
    }

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/env-file", cookies });
    expect(res.statusCode).toBe(200);

    const body = (res.json() as { body: string }).body;
    expect(body).toBe("API_URL=https://api.example.com\nSENTRY_DSN=••••\n");
    // The variable that was not ticked is absent, and no masked value left the
    // server — the property the whole vault rests on.
    expect(res.body).not.toContain("MATCH_PASSWORD");
    expect(res.body).not.toContain("sentry.example");
    expect(res.body).not.toContain("correct-horse-battery");
  });

  it("says the project names no file when it does not", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/env-file", cookies });
    expect(res.json()).toMatchObject({ path: null, provenance: null });
  });
});

describe("turning the environment file on", () => {
  const configOf = async (root: string): Promise<string> => readFile(join(root, "config.yml"), "utf8");

  it("writes the setting into config.yml, and clears it again", async () => {
    const { app, root } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const on = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/env-file",
      cookies,
      payload: { path: ".env" },
    });
    expect(on.statusCode).toBe(204);
    expect(await configOf(root)).toContain("env_file: .env");
    expect((await app.inject({ method: "GET", url: "/api/projects/sample/env-file", cookies })).json())
      .toMatchObject({ path: ".env", provenance: "server" });

    const off = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/env-file",
      cookies,
      payload: { path: null },
    });
    expect(off.statusCode).toBe(204);
    expect(await configOf(root)).not.toContain("env_file");
    expect((await app.inject({ method: "GET", url: "/api/projects/sample/env-file", cookies })).json())
      .toMatchObject({ path: null });
  });

  it("leaves every other line of the file alone", async () => {
    // It is hand-written and holds password hashes. A screen that reflowed it
    // would be one nobody dares press twice. Compared line by line rather than
    // byte for byte: `serializeYaml` drops a leading blank line, here and in
    // every other place this file is written, and that is not this route's doing.
    const { app, root } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const lines = (text: string): string[] => text.split("\n").filter((l) => l.trim() !== "");
    const before = lines(await configOf(root));

    await app.inject({ method: "PUT", url: "/api/projects/sample/env-file", cookies, payload: { path: ".env" } });
    expect(lines(await configOf(root))).toEqual([...before, "    env_file: .env"]);

    await app.inject({ method: "PUT", url: "/api/projects/sample/env-file", cookies, payload: { path: null } });
    expect(lines(await configOf(root))).toEqual(before);
  });

  it("refuses a path that climbs out of the app", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    for (const path of ["../.env", "/etc/passwd", "a/../../b/.env", ""]) {
      const res = await app.inject({ method: "PUT", url: "/api/projects/sample/env-file", cookies, payload: { path } });
      expect(res.statusCode).toBe(400);
    }
  });

  it("404s a project nobody carries", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/nope/env-file",
      cookies,
      payload: { path: ".env" },
    });
    expect(res.statusCode).toBe(404);
  });
});

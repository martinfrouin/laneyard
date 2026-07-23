import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildApp } from "../../src/server/app.js";
import { hashPassword, verifyPassword } from "../../src/server/auth.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { tmpDir } from "../fixtures/repos.js";

const ADMIN_PASSWORD = "admin pass";
const BUILDER_PASSWORD = "builder pass";

const TWO_ACCOUNTS = `
server:
  users:
    - { name: martin, role: admin, password_hash: "${hashPassword(ADMIN_PASSWORD)}" }
    - { name: ci, role: builder, password_hash: "${hashPassword(BUILDER_PASSWORD)}" }
`;

async function harness(configContent = TWO_ACCOUNTS) {
  const root = await tmpDir("laneyard-account-");
  const configPath = join(root, "config.yml");
  await writeFile(configPath, configContent, "utf8");

  const config = new ConfigStore(configPath);
  await config.load();
  const db = openDatabase(":memory:");

  const app = await buildApp({
    config,
    db,
    root,
    lanes: async () => [],
    uses: async () => ({ lanes: [], imports: false }),
    vault: await Vault.open(root, new SecretStore(db), new CredentialStore(db)),
  });

  const login = async (name: string, password: string): Promise<string> => {
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { name, password } });
    expect(res.statusCode).toBe(200);
    return res.cookies[0]!.value;
  };

  const change = async (session: string, current: string, next: string) =>
    app.inject({
      method: "POST",
      url: "/api/account/password",
      cookies: { laneyard_session: session },
      payload: { current, next },
    });

  const rename = async (session: string, current: string, next: string) =>
    app.inject({
      method: "POST",
      url: "/api/account/name",
      cookies: { laneyard_session: session },
      payload: { current, next },
    });

  const users = async () =>
    (
      parse(await readFile(configPath, "utf8")) as {
        server: {
          users: { name: string; role: string; password_hash: string; projects?: string[] }[];
        };
      }
    ).server.users;

  const hashOf = async (name: string) => (await users()).find((u) => u.name === name)!;

  return { app, login, change, rename, users, hashOf };
}

describe("POST /api/account/password", () => {
  it("writes the new password and lets it sign in", async () => {
    const { login, change, hashOf } = await harness();
    const res = await change(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, "a longer one");

    expect(res.statusCode).toBe(204);
    const entry = await hashOf("martin");
    expect(await verifyPassword("a longer one", entry.password_hash)).toBe(true);
    expect(await verifyPassword(ADMIN_PASSWORD, entry.password_hash)).toBe(false);
  });

  // The whole reason this route is not under /api/users, which is admin-only.
  it("is open to a builder, for their own password", async () => {
    const { login, change, hashOf } = await harness();
    const res = await change(await login("ci", BUILDER_PASSWORD), BUILDER_PASSWORD, "another one");

    expect(res.statusCode).toBe(204);
    expect(await verifyPassword("another one", (await hashOf("ci")).password_hash)).toBe(true);
  });

  it("keeps the role it had — the body cannot hand out admin", async () => {
    const { app, login, hashOf } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password",
      cookies: { laneyard_session: await login("ci", BUILDER_PASSWORD) },
      payload: { current: BUILDER_PASSWORD, next: "another one", role: "admin" },
    });

    expect(res.statusCode).toBe(204);
    expect((await hashOf("ci")).role).toBe("builder");
  });

  it("refuses a wrong current password, and leaves the stored one alone", async () => {
    const { login, change, hashOf } = await harness();
    const res = await change(await login("martin", ADMIN_PASSWORD), "not it", "a longer one");

    expect(res.statusCode).toBe(401);
    expect(await verifyPassword(ADMIN_PASSWORD, (await hashOf("martin")).password_hash)).toBe(true);
  });

  it("refuses a password shorter than the minimum", async () => {
    const { login, change } = await harness();
    const res = await change(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, "short");

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least/);
  });

  it("refuses the password already in use", async () => {
    const { login, change } = await harness();
    const res = await change(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, ADMIN_PASSWORD);

    expect(res.statusCode).toBe(400);
  });

  it("needs a session at all", async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password",
      payload: { current: ADMIN_PASSWORD, next: "a longer one" },
    });

    expect(res.statusCode).toBe(401);
  });

  /**
   * A password is changed by someone who wants another browser to stop being
   * signed in. If the old cookie kept working, that is exactly what would not
   * happen — and the change would be theatre.
   */
  it("ends every other session the account had", async () => {
    const { app, login, change } = await harness();
    const phone = await login("martin", ADMIN_PASSWORD);
    const laptop = await login("martin", ADMIN_PASSWORD);

    expect((await change(laptop, ADMIN_PASSWORD, "a longer one")).statusCode).toBe(204);

    const res = await app.inject({ method: "GET", url: "/api/me", cookies: { laneyard_session: phone } });
    expect(res.statusCode).toBe(401);
  });

  it("hands back a working session, so the page that did it stays signed in", async () => {
    const { app, login, change } = await harness();
    const res = await change(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, "a longer one");

    const fresh = res.cookies.find((c) => c.name === "laneyard_session")!.value as string;
    const me = await app.inject({ method: "GET", url: "/api/me", cookies: { laneyard_session: fresh } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ name: "martin", role: "admin" });
  });

  // Nobody else's account is reachable from here: there is no name in the body,
  // and the only one the handler will ever write is the session's own.
  it("cannot touch another account", async () => {
    const { app, login, hashOf } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password",
      cookies: { laneyard_session: await login("ci", BUILDER_PASSWORD) },
      payload: { name: "martin", current: BUILDER_PASSWORD, next: "another one" },
    });

    expect(res.statusCode).toBe(204);
    expect(await verifyPassword(ADMIN_PASSWORD, (await hashOf("martin")).password_hash)).toBe(true);
  });
});

describe("POST /api/account/name", () => {
  it("renames the entry in place and lets the new name in, the old one out", async () => {
    const { login, rename, users } = await harness();
    const res = await rename(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, "martin2");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "martin2", role: "admin" });
    expect((await users()).map((u) => u.name)).toEqual(["martin2", "ci"]);
  });

  it("keeps the role and the password_hash the entry had", async () => {
    // A rename is an edit of one field; the account is otherwise the same account
    // and must still authenticate with the very same password it did before.
    const { login, rename, hashOf } = await harness();
    await rename(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, "martin2");

    const entry = await hashOf("martin2");
    expect(entry.role).toBe("admin");
    expect(await verifyPassword(ADMIN_PASSWORD, entry.password_hash)).toBe(true);
  });

  // The whole reason for the dedicated helper: an upsert keyed by the new name
  // would orphan the old entry and drop its grants with it.
  it("preserves the account's project grants across the rename", async () => {
    const CONFIG = `
server:
  users:
    - { name: martin, role: admin, password_hash: "${hashPassword(ADMIN_PASSWORD)}" }
    - { name: ci, role: builder, password_hash: "${hashPassword(BUILDER_PASSWORD)}", projects: [cartes-ios] }
`;
    const { login, rename, hashOf } = await harness(CONFIG);
    const res = await rename(await login("ci", BUILDER_PASSWORD), BUILDER_PASSWORD, "ci2");

    expect(res.statusCode).toBe(200);
    expect((await hashOf("ci2")).projects).toEqual(["cartes-ios"]);
  });

  // The reason this route is not under /api/users, which is admin-only.
  it("is open to a builder, for their own name", async () => {
    const { login, rename, users } = await harness();
    const res = await rename(await login("ci", BUILDER_PASSWORD), BUILDER_PASSWORD, "ci2");

    expect(res.statusCode).toBe(200);
    expect((await users()).map((u) => u.name)).toEqual(["martin", "ci2"]);
  });

  it("carries the role over — the body cannot hand out admin", async () => {
    const { app, login, hashOf } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/name",
      cookies: { laneyard_session: await login("ci", BUILDER_PASSWORD) },
      payload: { current: BUILDER_PASSWORD, next: "ci2", role: "admin" },
    });

    expect(res.statusCode).toBe(200);
    expect((await hashOf("ci2")).role).toBe("builder");
  });

  it("refuses a wrong current password, and writes nothing", async () => {
    const { login, rename, users } = await harness();
    const res = await rename(await login("martin", ADMIN_PASSWORD), "not it", "martin2");

    expect(res.statusCode).toBe(401);
    expect((await users()).map((u) => u.name)).toEqual(["martin", "ci"]);
  });

  it("refuses a name that already belongs to another account", async () => {
    const { login, rename, users } = await harness();
    const res = await rename(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, "ci");

    expect(res.statusCode).toBe(409);
    // Untouched: both accounts keep the names they had.
    expect((await users()).map((u) => u.name)).toEqual(["martin", "ci"]);
  });

  it("refuses a name that would not be a name", async () => {
    const { login, rename } = await harness();
    const session = await login("martin", ADMIN_PASSWORD);
    for (const name of ["", "no spaces", "../etc", "él"]) {
      expect([name, (await rename(session, ADMIN_PASSWORD, name)).statusCode]).toEqual([name, 400]);
    }
  });

  it("treats renaming to the name you already have as a gentle no-op", async () => {
    const { login, rename } = await harness();
    const res = await rename(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, "martin");

    expect(res.statusCode).toBe(400);
  });

  it("needs a session at all", async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/name",
      payload: { current: ADMIN_PASSWORD, next: "martin2" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("ends every other session the account had", async () => {
    const { app, login, rename } = await harness();
    const phone = await login("martin", ADMIN_PASSWORD);
    const laptop = await login("martin", ADMIN_PASSWORD);

    expect((await rename(laptop, ADMIN_PASSWORD, "martin2")).statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/api/me", cookies: { laneyard_session: phone } });
    expect(res.statusCode).toBe(401);
  });

  it("hands back a working session under the new name, so the page stays signed in", async () => {
    const { app, login, rename } = await harness();
    const res = await rename(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, "martin2");

    const fresh = res.cookies.find((c) => c.name === "laneyard_session")!.value as string;
    const me = await app.inject({ method: "GET", url: "/api/me", cookies: { laneyard_session: fresh } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ name: "martin2", role: "admin" });
  });

  it("lets the account log in under the new name afterwards", async () => {
    const { app, login, rename } = await harness();
    await rename(await login("martin", ADMIN_PASSWORD), ADMIN_PASSWORD, "martin2");

    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { name: "martin2", password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });
});

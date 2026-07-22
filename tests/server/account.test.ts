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

async function harness() {
  const root = await tmpDir("laneyard-account-");
  const configPath = join(root, "config.yml");
  await writeFile(configPath, TWO_ACCOUNTS, "utf8");

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

  const hashOf = async (name: string) => {
    const doc = parse(await readFile(configPath, "utf8")) as {
      server: { users: { name: string; role: string; password_hash: string }[] };
    };
    return doc.server.users.find((u) => u.name === name)!;
  };

  return { app, login, change, hashOf };
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

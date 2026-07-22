import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildApp } from "../../src/server/app.js";
import { hashPassword } from "../../src/server/auth.js";
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

const LEGACY = `# a 0.2 configuration
server:
  port: 7890
  password_hash: "${hashPassword(ADMIN_PASSWORD)}"   # written by laneyard setup
`;

async function harness(configContent = TWO_ACCOUNTS) {
  const root = await tmpDir("laneyard-users-");
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
    uses: async () => [],
    vault: await Vault.open(root, new SecretStore(db), new CredentialStore(db)),
  });

  const login = async (name: string, password: string): Promise<string | null> => {
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { name, password } });
    return res.statusCode === 200 ? res.cookies[0]!.value : null;
  };

  const asAdmin = async () => ({
    laneyard_session: (await login("martin", ADMIN_PASSWORD)) ?? (await login("admin", ADMIN_PASSWORD))!,
  });

  const written = async () =>
    parse(await readFile(configPath, "utf8")) as {
      server: { password_hash?: string; users?: { name: string; role: string; password_hash: string }[] };
    };

  /** Rewrites config.yml behind the server's back, as `laneyard user` and a text editor both do. */
  const rewrite = async (content: string) => {
    await writeFile(configPath, content, "utf8");
    await config.load();
  };

  return { app, root, configPath, login, asAdmin, written, rewrite };
}

describe("GET /api/users", () => {
  it("lists names and roles", async () => {
    const { app, asAdmin } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/users", cookies: await asAdmin() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: "martin", role: "admin" },
      { name: "ci", role: "builder" },
    ]);
  });

  it("never sends a hash, not even a truncated one", async () => {
    // The listing is read by a browser. A hash that reaches it is a hash that
    // reaches anything looking at that browser's traffic, for no benefit at all.
    const { app, asAdmin } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/users", cookies: await asAdmin() });
    expect(res.body).not.toContain("scrypt");
  });
});

describe("POST /api/users", () => {
  it("creates an account that can then log in", async () => {
    const { app, asAdmin, login } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: await asAdmin(),
      payload: { name: "renaud", role: "builder", password: "a long enough password" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "renaud", role: "builder" });
    expect(await login("renaud", "a long enough password")).not.toBeNull();
  });

  it("writes the account into config.yml, hashed", async () => {
    const { app, asAdmin, written } = await harness();
    await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: await asAdmin(),
      payload: { name: "renaud", role: "builder", password: "a long enough password" },
    });

    const users = (await written()).server.users!;
    expect(users.map((u) => u.name)).toEqual(["martin", "ci", "renaud"]);
    expect(users[2]!.password_hash).toMatch(/^scrypt\$/);
    expect(users[2]!.password_hash).not.toContain("a long enough password");
  });

  it("refuses a name that would not be a name", async () => {
    const { app, asAdmin } = await harness();
    const cookies = await asAdmin();
    for (const name of ["", "no spaces", "../etc", "él"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/users",
        cookies,
        payload: { name, role: "builder", password: "a long enough password" },
      });
      expect([name, res.statusCode]).toEqual([name, 400]);
    }
  });

  it("refuses a role it does not have", async () => {
    const { app, asAdmin } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: await asAdmin(),
      payload: { name: "renaud", role: "root", password: "a long enough password" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a password too short to be worth hashing", async () => {
    const { app, asAdmin } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: await asAdmin(),
      payload: { name: "renaud", role: "builder", password: "abc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("replaces an account of the same name, and ends its sessions", async () => {
    // The session carries a snapshot of who someone is. Rewriting the account
    // without dropping it would leave the old role and the old password live.
    const { app, asAdmin, login } = await harness();
    const builder = { laneyard_session: (await login("ci", BUILDER_PASSWORD))! };
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: builder })).statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: await asAdmin(),
      payload: { name: "ci", role: "builder", password: "another long password" },
    });

    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: builder })).statusCode).toBe(401);
    expect(await login("ci", BUILDER_PASSWORD)).toBeNull();
    expect(await login("ci", "another long password")).not.toBeNull();
  });

  it("refuses to demote the last admin", async () => {
    const { app, asAdmin, written } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: await asAdmin(),
      payload: { name: "martin", role: "builder", password: "a long enough password" },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/admin/i);
    // And the file is untouched: a refusal that half-writes is worse than none.
    expect((await written()).server.users!.find((u) => u.name === "martin")!.role).toBe("admin");
  });

  it("lets an admin be demoted while another one remains", async () => {
    const { app, asAdmin, written } = await harness();
    const cookies = await asAdmin();
    await app.inject({
      method: "POST",
      url: "/api/users",
      cookies,
      payload: { name: "renaud", role: "admin", password: "a long enough password" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies,
      payload: { name: "martin", role: "builder", password: "a long enough password" },
    });

    expect(res.statusCode).toBe(200);
    expect((await written()).server.users!.find((u) => u.name === "martin")!.role).toBe("builder");
  });
});

describe("DELETE /api/users/:name", () => {
  it("removes the account from config.yml", async () => {
    const { app, asAdmin, written } = await harness();
    const res = await app.inject({ method: "DELETE", url: "/api/users/ci", cookies: await asAdmin() });

    expect(res.statusCode).toBe(204);
    expect((await written()).server.users!.map((u) => u.name)).toEqual(["martin"]);
  });

  it("ends that account's sessions — removing an account is revoking access", async () => {
    // Otherwise "remove the account" and "revoke access" are two different
    // things, while every interface that offers the first implies the second.
    const { app, asAdmin, login } = await harness();
    const builder = { laneyard_session: (await login("ci", BUILDER_PASSWORD))! };
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: builder })).statusCode).toBe(200);

    await app.inject({ method: "DELETE", url: "/api/users/ci", cookies: await asAdmin() });

    expect((await app.inject({ method: "GET", url: "/api/me", cookies: builder })).statusCode).toBe(401);
    expect(await login("ci", BUILDER_PASSWORD)).toBeNull();
  });

  it("leaves everybody else's sessions alone", async () => {
    const { app, asAdmin, login } = await harness();
    const admin = await asAdmin();
    const builder = { laneyard_session: (await login("ci", BUILDER_PASSWORD))! };

    await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: admin,
      payload: { name: "renaud", role: "builder", password: "a long enough password" },
    });
    await app.inject({ method: "DELETE", url: "/api/users/renaud", cookies: admin });

    expect((await app.inject({ method: "GET", url: "/api/me", cookies: builder })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: admin })).statusCode).toBe(200);
  });

  it("refuses to remove the last admin", async () => {
    const { app, asAdmin, written } = await harness();
    const res = await app.inject({ method: "DELETE", url: "/api/users/martin", cookies: await asAdmin() });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/admin/i);
    expect((await written()).server.users!.map((u) => u.name)).toContain("martin");
  });

  it("answers 404 for a name nobody carries", async () => {
    const { app, asAdmin } = await harness();
    const res = await app.inject({ method: "DELETE", url: "/api/users/nobody", cookies: await asAdmin() });
    expect(res.statusCode).toBe(404);
  });
});

describe("a 0.2 configuration", () => {
  it("gains its second account without losing its first", async () => {
    // The bare `password_hash` becomes `users`, because a file holding both is
    // the one combination the loader refuses — adding a colleague must not be
    // the thing that stops the server from reading its own configuration.
    const { app, asAdmin, login, written } = await harness(LEGACY);
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: await asAdmin(),
      payload: { name: "ci", role: "builder", password: "a long enough password" },
    });

    expect(res.statusCode).toBe(201);
    const file = await written();
    expect(file.server.password_hash).toBeUndefined();
    expect(file.server.users!.map((u) => [u.name, u.role])).toEqual([
      ["admin", "admin"],
      ["ci", "builder"],
    ]);
    // The original password still opens the original account.
    expect(await login("admin", ADMIN_PASSWORD)).not.toBeNull();
  });

  it("keeps the comments of a hand-written file", async () => {
    const { app, asAdmin, configPath } = await harness(LEGACY);
    await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: await asAdmin(),
      payload: { name: "ci", role: "builder", password: "a long enough password" },
    });

    expect(await readFile(configPath, "utf8")).toContain("# a 0.2 configuration");
  });
});

describe("a session against a configuration that moved", () => {
  it("stops working when the account leaves the file by any other route", async () => {
    // `laneyard user add` runs in another process, and config.yml is a file
    // anyone may edit. Revoking sessions from the route that removed an account
    // cannot cover either, so the account is looked up again on every request.
    const { app, login, rewrite } = await harness();
    const builder = { laneyard_session: (await login("ci", BUILDER_PASSWORD))! };

    await rewrite(`
server:
  users:
    - { name: martin, role: admin, password_hash: "${hashPassword(ADMIN_PASSWORD)}" }
`);

    expect((await app.inject({ method: "GET", url: "/api/me", cookies: builder })).statusCode).toBe(401);
  });

  it("carries the role the file gives today, not the one it gave at login", async () => {
    const { app, login, rewrite } = await harness();
    const cookies = { laneyard_session: (await login("martin", ADMIN_PASSWORD))! };
    expect((await app.inject({ method: "GET", url: "/api/secrets", cookies })).statusCode).toBe(200);

    await rewrite(`
server:
  users:
    - { name: martin, role: builder, password_hash: "${hashPassword(ADMIN_PASSWORD)}" }
    - { name: ci, role: admin, password_hash: "${hashPassword(BUILDER_PASSWORD)}" }
`);

    expect((await app.inject({ method: "GET", url: "/api/me", cookies })).json()).toEqual({
      name: "martin",
      role: "builder",
    });
    expect((await app.inject({ method: "GET", url: "/api/secrets", cookies })).statusCode).toBe(403);
  });
});

describe("signing out", () => {
  it("ends the session it was made with, and no other", async () => {
    const { app, login } = await harness();
    const first = { laneyard_session: (await login("ci", BUILDER_PASSWORD))! };
    const second = { laneyard_session: (await login("ci", BUILDER_PASSWORD))! };

    const res = await app.inject({ method: "POST", url: "/api/logout", cookies: first });
    expect(res.statusCode).toBe(204);

    expect((await app.inject({ method: "GET", url: "/api/me", cookies: first })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: second })).statusCode).toBe(200);
  });
});

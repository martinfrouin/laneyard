import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runUserCommand } from "../../src/cli/user.js";
import { authenticate, hashPassword } from "../../src/server/auth.js";
import { loadServerConfig } from "../../src/config/load.js";
import type { UserEntry } from "../../src/config/schema.js";
import { tmpDir } from "../fixtures/repos.js";

const TWO_ACCOUNTS = `# hand-written
server:
  users:
    - { name: martin, role: admin, password_hash: "${hashPassword("admin pass")}" }
    - { name: ci, role: builder, password_hash: "${hashPassword("builder pass")}" }
`;

async function home(config = TWO_ACCOUNTS): Promise<string> {
  const dir = await tmpDir("laneyard-cli-user-");
  await writeFile(join(dir, "config.yml"), config, "utf8");
  return dir;
}

/** Runs the command with a password piped in, collecting what it printed. */
async function run(dir: string, args: string[], stdin = "a long enough password") {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUserCommand(dir, args, {
    stdin: Readable.from([stdin]),
    interactive: false,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** The accounts as the server itself would read them. */
async function loadedUsers(dir: string): Promise<UserEntry[]> {
  const loaded = await loadServerConfig(join(dir, "config.yml"));
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.config.server.users;
}

const accountsIn = async (dir: string) =>
  (parse(await readFile(join(dir, "config.yml"), "utf8")) as {
    server: { users: { name: string; role: string; password_hash: string; projects?: string[] }[] };
  }).server.users;

describe("laneyard user add", () => {
  it("adds a builder whose password came from standard input", async () => {
    const dir = await home();
    const { code, out } = await run(dir, ["add", "renaud", "--role", "builder"]);

    expect(code).toBe(0);
    const users = await accountsIn(dir);
    expect(users.map((u) => [u.name, u.role])).toContainEqual(["renaud", "builder"]);
    // Nothing it prints ever contains the password: a terminal keeps scrollback.
    expect(out).not.toContain("a long enough password");

    const identity = await authenticate(await loadedUsers(dir), "renaud", "a long enough password");
    expect(identity).toEqual({ name: "renaud", role: "builder" });
  });

  it("defaults to the role that can do the least", async () => {
    const dir = await home();
    await run(dir, ["add", "renaud"]);
    expect((await accountsIn(dir)).find((u) => u.name === "renaud")!.role).toBe("builder");
  });

  it("starts a new account reaching no project", async () => {
    // `projects: []` is the empty grant, told apart from an absent field: a new
    // builder sees nothing until an admin grants it a project.
    const dir = await home();
    await run(dir, ["add", "renaud"]);
    expect((await accountsIn(dir)).find((u) => u.name === "renaud")!.projects).toEqual([]);
  });

  it("keeps the comments of a hand-written file", async () => {
    const dir = await home();
    await run(dir, ["add", "renaud"]);
    expect(await readFile(join(dir, "config.yml"), "utf8")).toContain("# hand-written");
  });

  it("refuses to take the password from the command line", async () => {
    // The whole point of reading standard input: an argument lands in history.
    const dir = await home();
    const { code, err } = await run(dir, ["add", "renaud", "hunter2hunter2"]);
    expect(code).toBe(1);
    expect(err).toMatch(/standard input/);
  });

  it("refuses when standard input is a terminal, and says how to pipe", async () => {
    const dir = await home();
    const err: string[] = [];
    const code = await runUserCommand(dir, ["add", "renaud"], {
      stdin: Readable.from([]),
      interactive: true,
      out: () => {},
      err: (t) => err.push(t),
    });
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/laneyard user add/);
  });

  it("refuses an empty password, and a short one", async () => {
    const dir = await home();
    expect((await run(dir, ["add", "renaud"], "")).code).toBe(1);
    expect((await run(dir, ["add", "renaud"], "abc")).code).toBe(1);
    expect((await accountsIn(dir)).map((u) => u.name)).toEqual(["martin", "ci"]);
  });

  it("refuses a name that would not be a name", async () => {
    const dir = await home();
    expect((await run(dir, ["add", "no spaces"])).code).toBe(1);
  });

  it("refuses a role it does not have", async () => {
    const dir = await home();
    const { code, err } = await run(dir, ["add", "renaud", "--role", "root"]);
    expect(code).toBe(1);
    expect(err).toMatch(/admin|builder/);
  });

  it("replaces an account of the same name, and says so", async () => {
    const dir = await home();
    const { code, out } = await run(dir, ["add", "ci", "--role", "builder"], "a brand new password");
    expect(code).toBe(0);
    expect(out).toMatch(/replaced/);

    const users = await loadedUsers(dir);
    expect(await authenticate(users, "ci", "a brand new password")).not.toBeNull();
    expect(await authenticate(users, "ci", "builder pass")).toBeNull();
  });

  it("refuses to demote the last admin, exactly as the API does", async () => {
    const dir = await home(`
server:
  users:
    - { name: martin, role: admin, password_hash: "${hashPassword("admin pass")}" }
`);
    const { code, err } = await run(dir, ["add", "martin", "--role", "builder"]);

    expect(code).toBe(1);
    expect(err).toMatch(/only admin/);
    expect((await accountsIn(dir))[0]!.role).toBe("admin");
  });

  it("sends a machine with no account to `laneyard setup`", async () => {
    // The first account has to be an admin, and this command would otherwise
    // happily write a lone builder — a configuration the server then refuses.
    const dir = await tmpDir("laneyard-cli-user-");
    const { code, err } = await run(dir, ["add", "renaud"]);
    expect(code).toBe(1);
    expect(err).toMatch(/laneyard setup/);
  });

  it("says what it understands when asked for something else", async () => {
    const dir = await home();
    const { code, err } = await run(dir, ["promote", "ci"]);
    expect(code).toBe(1);
    expect(err).toMatch(/laneyard user add/);
  });
});

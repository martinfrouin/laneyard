import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerFromConfig } from "../src/main.js";
import { hashPassword } from "../src/server/auth.js";
import { openDatabase } from "../src/db/open.js";
import { RunStore } from "../src/db/runs.js";
import { tmpDir } from "./fixtures/repos.js";

describe("createServerFromConfig", () => {
  it("refuses to start if the configuration is invalid", async () => {
    const root = await tmpDir("laneyard-main-");
    await writeFile(join(root, "config.yml"), "projects: [", "utf8");
    await expect(createServerFromConfig(root)).rejects.toThrow(/configuration/i);
  });

  it("marks runs still active at startup as interrupted", async () => {
    const root = await tmpDir("laneyard-main-");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.yml"),
      `server: { users: [{ name: admin, role: admin, password_hash: "${hashPassword("x")}" }] }\nprojects: []\n`,
      "utf8",
    );

    const dbPath = join(root, "laneyard.db");
    const runs = new RunStore(openDatabase(dbPath));
    const id = runs.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    runs.markRunning(id, { branch: "main", commitSha: "x" });

    const { app, db } = await createServerFromConfig(root);
    await app.close();

    expect(new RunStore(db).get(id)?.status).toBe("interrupted");
  });

  it("resumes a run left queued by a previous life", async () => {
    // The queue is discovered from the database, never pushed to: a run queued
    // before a restart has to start moving again on its own, without anyone
    // happening to trigger a fourth one.
    const root = await tmpDir("laneyard-main-");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.yml"),
      `server: { users: [{ name: admin, role: admin, password_hash: "${hashPassword("x")}" }] }\nprojects: []\n`,
      "utf8",
    );

    const dbPath = join(root, "laneyard.db");
    const id = new RunStore(openDatabase(dbPath)).create({
      projectSlug: "gone",
      lane: "beta",
      platform: null,
      params: {},
    });

    const { app, db } = await createServerFromConfig(root);
    await app.queue.idle();
    await app.close();

    expect(new RunStore(db).get(id)?.status).not.toBe("queued");
  });

  it("creates the vault key on first start", async () => {
    const root = await tmpDir("laneyard-main-");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.yml"),
      `server: { users: [{ name: admin, role: admin, password_hash: "${hashPassword("x")}" }] }\nprojects: []\n`,
      "utf8",
    );

    const { app } = await createServerFromConfig(root);
    await app.close();

    const info = await stat(join(root, "key"));
    expect(info.mode & 0o077).toBe(0);
  });
});

describe("the renamed command", () => {
  it("tells anyone still typing `add` what the command is called now", async () => {
    // 0.1.0 shipped this as `add`. Someone who learned that name deserves a
    // sentence rather than "Unknown command".
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");

    const result = await promisify(execFile)(
      process.execPath,
      // Run the built entry point: type stripping does not rewrite the `.js`
      // specifiers NodeNext requires, so the sources cannot be run directly.
      ["dist/src/main.js", "add"],
      { cwd: process.cwd(), env: { ...process.env, LANEYARD_HOME: await tmpDir() } },
    ).catch((e: { stderr: string; code: number }) => e);

    expect((result as { stderr: string }).stderr).toContain("`laneyard add` is now `laneyard setup`");
  }, 60_000);
});

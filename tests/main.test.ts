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
      `server: { password_hash: "${hashPassword("x")}" }\nprojects: []\n`,
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

  it("creates the vault key on first start", async () => {
    const root = await tmpDir("laneyard-main-");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.yml"),
      `server: { password_hash: "${hashPassword("x")}" }\nprojects: []\n`,
      "utf8",
    );

    const { app } = await createServerFromConfig(root);
    await app.close();

    const info = await stat(join(root, "key"));
    expect(info.mode & 0o077).toBe(0);
  });
});

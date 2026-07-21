import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { tmpDir } from "../fixtures/repos.js";

describe("introspection cache migration", () => {
  it("rebuilds a cache table written before the kind column existed", async () => {
    const path = join(await tmpDir("laneyard-mig-"), "laneyard.db");

    // Exactly the shape 0.1.0 wrote. `CREATE TABLE IF NOT EXISTS` would leave it
    // alone, and the second reader's writes would then collide with the first's.
    const old = new Database(path);
    old.exec(
      `CREATE TABLE introspection_cache (
         project_slug TEXT PRIMARY KEY, config_hash TEXT NOT NULL,
         payload TEXT NOT NULL, fetched_at TEXT NOT NULL)`,
    );
    old.prepare("INSERT INTO introspection_cache VALUES (?, ?, ?, ?)").run("app", "h", "[]", "now");
    old.close();

    const db = openDatabase(path);
    const columns = (db.prepare("PRAGMA table_info(introspection_cache)").all() as { name: string }[])
      .map((c) => c.name);

    expect(columns).toContain("kind");
    // The rows are gone, and that is the point: this is a cache, so rebuilding
    // it costs one slow read and nothing else.
    expect((db.prepare("SELECT COUNT(*) AS n FROM introspection_cache").get() as { n: number }).n).toBe(0);
  });

  it("leaves an already-migrated database alone", async () => {
    const path = join(await tmpDir("laneyard-mig-"), "laneyard.db");
    openDatabase(path).prepare(
      "INSERT INTO introspection_cache VALUES (?, ?, ?, ?, ?)",
    ).run("app", "lanes", "h", "[]", "now");

    const again = openDatabase(path);
    expect((again.prepare("SELECT COUNT(*) AS n FROM introspection_cache").get() as { n: number }).n).toBe(1);
  });
});

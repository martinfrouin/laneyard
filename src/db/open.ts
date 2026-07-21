import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateIntrospectionCache(db);

  const here = dirname(fileURLToPath(import.meta.url));
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return db;
}

/**
 * Rebuilds the introspection cache when it predates the `kind` column.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a database
 * written by 0.1.0 would keep the old single-key shape and collide. Dropping is
 * the right answer here and only here: this table is a cache, and losing it
 * costs one slow read.
 */
function migrateIntrospectionCache(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(introspection_cache)").all() as { name: string }[];
  if (columns.length > 0 && !columns.some((c) => c.name === "kind")) {
    db.exec("DROP TABLE introspection_cache");
  }
}

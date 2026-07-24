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

  // After the schema, not before: on a fresh database the table has to exist
  // for the column check to mean anything, and there `CREATE TABLE` has already
  // put the column in.
  migrateEnvFileColumn(db);
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

/**
 * Adds `secret.in_env_file` to a database written before the environment file
 * existed.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a column added
 * to the schema never reaches a database that already has the table. The cache
 * above answers that by dropping and rebuilding; here that would delete the
 * vault. `ALTER TABLE … ADD COLUMN` with a default is the whole migration: every
 * row that predates the column reads as "not in the file", which is exactly what
 * it was.
 */
function migrateEnvFileColumn(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(secret)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "in_env_file")) {
    db.exec("ALTER TABLE secret ADD COLUMN in_env_file INTEGER NOT NULL DEFAULT 0");
  }
}

import type { Db } from "./open.js";

/** What the migration did, so the server can say it out loud. */
export interface GlobalScopeMigration {
  copied: { what: "secret" | "signing block"; name: string; slugs: string[] }[];
  dropped: { what: "secret" | "signing block"; name: string }[];
}

/** The two tables that carried a scope, and the column that identified a row in each. */
const TABLES = [
  { table: "secret", column: "key", what: "secret" as const },
  { table: "credential", column: "kind", what: "signing block" as const },
];

/**
 * Gives every row that belonged to everything to each project that read it.
 *
 * The vault used to have two scopes: a row stored under the empty slug applied
 * to every project, and a row under a real slug shadowed it. That is gone — a
 * secret and a signing block now belong to exactly one project — and this is
 * what happens to the rows written before it went.
 *
 * **Copied, never dropped.** A global secret was read by every project, so
 * writing it into every project preserves precisely the behaviour it had:
 * nothing that built yesterday stops building today. The alternative — deleting
 * rows the user never asked to delete, on an upgrade — would break working
 * projects to tidy a table.
 *
 * **A project that overrode a global one keeps its own value.** The insert
 * takes no action on conflict, which is the same precedence the merged read
 * applied, made permanent rather than recomputed on every query.
 *
 * The cost is real and is the point of the report: someone who stored one App
 * Store Connect key now has five, and rotating it means replacing five. They
 * have to be told, or they will find out from a build that uploads with a key
 * they thought they had replaced.
 *
 * With no projects configured there is nowhere to copy to, and the row is
 * deleted rather than left: every query names a slug now, so the empty one is
 * unreachable — not shared, just invisible and forever unread.
 */
export function migrateGlobalScope(db: Db, slugs: string[]): GlobalScopeMigration {
  const report: GlobalScopeMigration = { copied: [], dropped: [] };

  const run = db.transaction(() => {
    for (const { table, column, what } of TABLES) {
      const names = (
        db.prepare(`SELECT ${column} AS name FROM ${table} WHERE project_slug = '' ORDER BY ${column}`).all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      if (names.length === 0) continue;

      // `SELECT ?, <rest>` rather than a read-then-write: it keeps every column
      // the table has without naming them here, so a column added later travels
      // with the copy instead of being silently dropped by a migration nobody
      // thought to update.
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      const rest = columns.filter((c) => c !== "project_slug");
      const copy = db.prepare(
        `INSERT INTO ${table} (project_slug, ${rest.join(", ")})
         SELECT ?, ${rest.join(", ")} FROM ${table} WHERE project_slug = '' AND ${column} = ?
         ON CONFLICT DO NOTHING`,
      );

      for (const name of names) {
        const wrote: string[] = [];
        for (const slug of slugs) if (copy.run(slug, name).changes > 0) wrote.push(slug);
        // Dropped means "deleted and copied nowhere", which covers two cases:
        // there was no project to copy into, and every project already defined
        // the name and kept its own. The second changes nothing anyone could
        // observe — the row was shadowed everywhere, so nothing ever read it —
        // but it is still a deletion, and a migration that deletes in silence is
        // one nobody can audit afterwards.
        if (wrote.length > 0) report.copied.push({ what, name, slugs: wrote });
        else report.dropped.push({ what, name });
      }

      db.prepare(`DELETE FROM ${table} WHERE project_slug = ''`).run();
    }
  });

  run();
  return report;
}

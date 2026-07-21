import type { Db } from "./open.js";

/**
 * What the cached payload is. Part of the key, not a detail: several readers
 * cache per project, and without this they would overwrite each other and hand
 * back a payload of the wrong shape.
 */
export type CacheKind = "lanes" | "uses";

export class CacheStore {
  constructor(private readonly db: Db) {}

  get(slug: string, kind: CacheKind, hash: string): unknown | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM introspection_cache WHERE project_slug = ? AND kind = ? AND config_hash = ?",
      )
      .get(slug, kind, hash) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }

  put(slug: string, kind: CacheKind, hash: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO introspection_cache (project_slug, kind, config_hash, payload, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_slug, kind) DO UPDATE
           SET config_hash = excluded.config_hash,
               payload = excluded.payload,
               fetched_at = excluded.fetched_at`,
      )
      .run(slug, kind, hash, JSON.stringify(payload), new Date().toISOString());
  }
}

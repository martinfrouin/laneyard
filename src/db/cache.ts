import type { Db } from "./open.js";

export class CacheStore {
  constructor(private readonly db: Db) {}

  get(slug: string, hash: string): unknown | null {
    const row = this.db
      .prepare("SELECT payload FROM introspection_cache WHERE project_slug = ? AND config_hash = ?")
      .get(slug, hash) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }

  put(slug: string, hash: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO introspection_cache (project_slug, config_hash, payload, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (project_slug) DO UPDATE
           SET config_hash = excluded.config_hash,
               payload = excluded.payload,
               fetched_at = excluded.fetched_at`,
      )
      .run(slug, hash, JSON.stringify(payload), new Date().toISOString());
  }
}

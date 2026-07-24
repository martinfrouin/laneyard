import type { Db } from "./open.js";

/** What a listing may expose. There is deliberately no value here. */
export interface SecretSummary {
  key: string;
  masked: boolean;
}

interface Row {
  project_slug: string;
  key: string;
  value_enc: string;
  masked: number;
}

/**
 * Stores encrypted secrets. Knows nothing about encryption itself: it takes and
 * returns ciphertext, so a bug here cannot leak a plaintext value.
 *
 * Every row belongs to exactly one project. There used to be a second scope —
 * a row under no project, read by all of them, shadowed by a project's own —
 * and it is gone: see `migrate-global-scope.ts`. What it cost was the answer to
 * "what does this project see", which was a merge of two sets that no screen
 * ever showed whole. It is now one query.
 */
export class SecretStore {
  constructor(private readonly db: Db) {}

  set(projectSlug: string, key: string, valueEnc: string, masked: boolean): void {
    this.db
      .prepare(
        `INSERT INTO secret (project_slug, key, value_enc, masked, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_slug, key) DO UPDATE
           SET value_enc = excluded.value_enc,
               masked = excluded.masked,
               updated_at = excluded.updated_at`,
      )
      .run(projectSlug, key, valueEnc, masked ? 1 : 0, new Date().toISOString());
  }

  private rows(projectSlug: string): Row[] {
    return this.db.prepare("SELECT * FROM secret WHERE project_slug = ? ORDER BY key").all(projectSlug) as Row[];
  }

  /** One row, ciphertext included, or undefined. */
  find(projectSlug: string, key: string): (SecretSummary & { valueEnc: string }) | undefined {
    const row = this.rows(projectSlug).find((r) => r.key === key);
    return row ? { key: row.key, masked: row.masked === 1, valueEnc: row.value_enc } : undefined;
  }

  /**
   * Flips whether a value is kept out of the logs, leaving the value alone.
   *
   * Its own operation rather than a re-`set`, because of a circle: to reveal a
   * value you must first declare it not secret, and declaring that by storing it
   * again would mean typing the value you were trying to read.
   *
   * Returns false when no row matches, so a caller can answer 404 rather than
   * report a change that did not happen.
   */
  setMasked(projectSlug: string, key: string, masked: boolean): boolean {
    return (
      this.db
        .prepare(
          `UPDATE secret SET masked = ?, updated_at = ?
           WHERE project_slug = ? AND key = ?`,
        )
        .run(masked ? 1 : 0, new Date().toISOString(), projectSlug, key).changes > 0
    );
  }

  /** Removes every row this project holds, and returns how many. */
  removeAll(projectSlug: string): number {
    return this.db.prepare("DELETE FROM secret WHERE project_slug = ?").run(projectSlug).changes;
  }

  list(projectSlug: string): SecretSummary[] {
    return this.rows(projectSlug).map((row) => ({ key: row.key, masked: row.masked === 1 }));
  }

  /** Ciphertext by name, for the vault to decrypt. */
  encrypted(projectSlug: string): Record<string, string> {
    return Object.fromEntries(this.rows(projectSlug).map((row) => [row.key, row.value_enc]));
  }

  /** Which of this project's secrets should be kept out of the logs. */
  maskedKeys(projectSlug: string): Set<string> {
    return new Set(
      this.rows(projectSlug)
        .filter((r) => r.masked === 1)
        .map((r) => r.key),
    );
  }

  remove(projectSlug: string, key: string): boolean {
    const res = this.db.prepare("DELETE FROM secret WHERE project_slug = ? AND key = ?").run(projectSlug, key);
    return res.changes > 0;
  }
}

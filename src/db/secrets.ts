import type { Db } from "./open.js";

export type Scope = "project" | "global";

/** What a listing may expose. There is deliberately no value here. */
export interface SecretSummary {
  key: string;
  masked: boolean;
  scope: Scope;
}

const GLOBAL = "";

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
 * A project secret shadows a global one of the same name — the same precedence
 * as the configuration, and the least surprising rule.
 */
export class SecretStore {
  constructor(private readonly db: Db) {}

  set(projectSlug: string | null, key: string, valueEnc: string, masked: boolean): void {
    this.db
      .prepare(
        `INSERT INTO secret (project_slug, key, value_enc, masked, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_slug, key) DO UPDATE
           SET value_enc = excluded.value_enc,
               masked = excluded.masked,
               updated_at = excluded.updated_at`,
      )
      .run(projectSlug ?? GLOBAL, key, valueEnc, masked ? 1 : 0, new Date().toISOString());
  }

  /** Rows that apply to a project, project scope winning over global. */
  private applicable(projectSlug: string): Row[] {
    const rows = this.db
      .prepare("SELECT * FROM secret WHERE project_slug IN (?, ?) ORDER BY key")
      .all(projectSlug, GLOBAL) as Row[];

    const byKey = new Map<string, Row>();
    for (const row of rows) {
      const existing = byKey.get(row.key);
      if (!existing || row.project_slug !== GLOBAL) byKey.set(row.key, row);
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  list(projectSlug: string): SecretSummary[] {
    return this.applicable(projectSlug).map((row) => ({
      key: row.key,
      masked: row.masked === 1,
      scope: row.project_slug === GLOBAL ? "global" : "project",
    }));
  }

  listGlobal(): SecretSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM secret WHERE project_slug = ? ORDER BY key")
      .all(GLOBAL) as Row[];
    return rows.map((row) => ({ key: row.key, masked: row.masked === 1, scope: "global" as const }));
  }

  /** Ciphertext by name, for the vault to decrypt. */
  encrypted(projectSlug: string): Record<string, string> {
    return Object.fromEntries(this.applicable(projectSlug).map((row) => [row.key, row.value_enc]));
  }

  /** Which of the applicable secrets should be kept out of the logs. */
  maskedKeys(projectSlug: string): Set<string> {
    return new Set(this.applicable(projectSlug).filter((r) => r.masked === 1).map((r) => r.key));
  }

  remove(projectSlug: string | null, key: string): boolean {
    const res = this.db
      .prepare("DELETE FROM secret WHERE project_slug = ? AND key = ?")
      .run(projectSlug ?? GLOBAL, key);
    return res.changes > 0;
  }
}

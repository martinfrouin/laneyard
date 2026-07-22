import type { Db } from "./open.js";

// Declared here in Task 1 and re-exported by `credentials/kinds.ts` in Task 2.
export type CredentialKind = "apple_asc" | "android_keystore" | "play_service_account";

/** What a listing may expose. No ciphertext, no field values. */
export interface CredentialSummary {
  kind: CredentialKind;
  fileName: string;
  scope: "project" | "global";
  varNames: Record<string, string>;
  updatedAt: string;
}

export interface CredentialInput {
  fileName: string;
  fileEnc: string;
  fieldsEnc: string;
  varNames: Record<string, string>;
}

const GLOBAL = "";

interface Row {
  project_slug: string;
  kind: CredentialKind;
  file_name: string;
  file_enc: string;
  fields_enc: string;
  var_names: string;
  updated_at: string;
}

/**
 * Stores signing credential blocks: a file plus the fields that make it
 * usable. Knows nothing about encryption itself: it takes and returns
 * ciphertext, so a bug here cannot leak a plaintext value.
 *
 * A project credential shadows a global one of the same kind — the same
 * precedence as `SecretStore`, and the least surprising rule.
 */
export class CredentialStore {
  constructor(private readonly db: Db) {}

  set(projectSlug: string | null, kind: CredentialKind, input: CredentialInput): void {
    this.db
      .prepare(
        `INSERT INTO credential (project_slug, kind, file_name, file_enc, fields_enc, var_names, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_slug, kind) DO UPDATE
           SET file_name  = excluded.file_name,
               file_enc   = excluded.file_enc,
               fields_enc = excluded.fields_enc,
               var_names  = excluded.var_names,
               updated_at = excluded.updated_at`,
      )
      .run(
        projectSlug ?? GLOBAL,
        kind,
        input.fileName,
        input.fileEnc,
        input.fieldsEnc,
        JSON.stringify(input.varNames),
        new Date().toISOString(),
      );
  }

  /** Rows that apply to a project, project scope winning over global. */
  applicable(projectSlug: string): (CredentialSummary & { fileEnc: string; fieldsEnc: string })[] {
    const rows = this.db
      .prepare("SELECT * FROM credential WHERE project_slug IN (?, ?) ORDER BY kind")
      .all(projectSlug, GLOBAL) as Row[];

    const byKind = new Map<CredentialKind, Row>();
    for (const row of rows) {
      const existing = byKind.get(row.kind);
      if (!existing || row.project_slug !== GLOBAL) byKind.set(row.kind, row);
    }
    return [...byKind.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((row) => this.toSummary(row));
  }

  /** One applicable block, ciphertext included, or undefined. */
  find(
    projectSlug: string,
    kind: CredentialKind,
  ): (CredentialSummary & { fileEnc: string; fieldsEnc: string }) | undefined {
    return this.applicable(projectSlug).find((r) => r.kind === kind);
  }

  list(projectSlug: string): CredentialSummary[] {
    return this.applicable(projectSlug).map(({ fileEnc: _fileEnc, fieldsEnc: _fieldsEnc, ...summary }) => summary);
  }

  /**
   * The blocks stored under this slug, and no global one.
   *
   * Same distinction as `SecretStore.listOwn`, and it matters more here: a
   * global keystore shadowed by nothing is shared by every project on the
   * machine, and counting it as one project's would offer to delete the one
   * credential every other project signs with.
   */
  listOwn(projectSlug: string): CredentialSummary[] {
    if (projectSlug === GLOBAL) return [];
    const rows = this.db
      .prepare("SELECT * FROM credential WHERE project_slug = ? ORDER BY kind")
      .all(projectSlug) as Row[];
    return rows.map((row) => {
      const { fileEnc: _fileEnc, fieldsEnc: _fieldsEnc, ...summary } = this.toSummary(row);
      return summary;
    });
  }

  /** Removes every block stored under this slug, and returns how many. */
  removeAllOwn(projectSlug: string): number {
    if (projectSlug === GLOBAL) return 0;
    return this.db.prepare("DELETE FROM credential WHERE project_slug = ?").run(projectSlug).changes;
  }

  listGlobal(): CredentialSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM credential WHERE project_slug = ? ORDER BY kind")
      .all(GLOBAL) as Row[];
    return rows.map((row) => {
      const { fileEnc: _fileEnc, fieldsEnc: _fieldsEnc, ...summary } = this.toSummary(row);
      return summary;
    });
  }

  remove(projectSlug: string | null, kind: CredentialKind): boolean {
    const res = this.db
      .prepare("DELETE FROM credential WHERE project_slug = ? AND kind = ?")
      .run(projectSlug ?? GLOBAL, kind);
    return res.changes > 0;
  }

  private toSummary(row: Row): CredentialSummary & { fileEnc: string; fieldsEnc: string } {
    return {
      kind: row.kind,
      fileName: row.file_name,
      fileEnc: row.file_enc,
      fieldsEnc: row.fields_enc,
      scope: row.project_slug === GLOBAL ? "global" : "project",
      varNames: JSON.parse(row.var_names),
      updatedAt: row.updated_at,
    };
  }
}

import type { Db } from "./open.js";

// Declared here in Task 1 and re-exported by `credentials/kinds.ts` in Task 2.
export type CredentialKind = "apple_asc" | "android_keystore" | "play_service_account";

/** What a listing may expose. No ciphertext, no field values. */
export interface CredentialSummary {
  kind: CredentialKind;
  fileName: string;
  varNames: Record<string, string>;
  updatedAt: string;
}

export interface CredentialInput {
  fileName: string;
  fileEnc: string;
  fieldsEnc: string;
  varNames: Record<string, string>;
}

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
 * One project, one block per kind. A block used to be storable under no project
 * and read by all of them — an App Store Connect key is usually one per
 * developer account, not one per app, so the sharing matched something real.
 * It went anyway: it meant no screen could show what a project actually signs
 * with. Five apps under one account now hold five copies of the key, and
 * rotating it means replacing five.
 */
export class CredentialStore {
  constructor(private readonly db: Db) {}

  set(projectSlug: string, kind: CredentialKind, input: CredentialInput): void {
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
        projectSlug,
        kind,
        input.fileName,
        input.fileEnc,
        input.fieldsEnc,
        JSON.stringify(input.varNames),
        new Date().toISOString(),
      );
  }

  /** This project's blocks, ciphertext included. */
  private rows(projectSlug: string): (CredentialSummary & { fileEnc: string; fieldsEnc: string })[] {
    const rows = this.db
      .prepare("SELECT * FROM credential WHERE project_slug = ? ORDER BY kind")
      .all(projectSlug) as Row[];
    return rows.map((row) => this.toSummary(row));
  }

  /** One block, ciphertext included, or undefined. */
  find(
    projectSlug: string,
    kind: CredentialKind,
  ): (CredentialSummary & { fileEnc: string; fieldsEnc: string }) | undefined {
    return this.rows(projectSlug).find((r) => r.kind === kind);
  }

  list(projectSlug: string): CredentialSummary[] {
    return this.rows(projectSlug).map(({ fileEnc: _fileEnc, fieldsEnc: _fieldsEnc, ...summary }) => summary);
  }

  /** Removes every block this project holds, and returns how many. */
  removeAll(projectSlug: string): number {
    return this.db.prepare("DELETE FROM credential WHERE project_slug = ?").run(projectSlug).changes;
  }

  remove(projectSlug: string, kind: CredentialKind): boolean {
    const res = this.db
      .prepare("DELETE FROM credential WHERE project_slug = ? AND kind = ?")
      .run(projectSlug, kind);
    return res.changes > 0;
  }

  private toSummary(row: Row): CredentialSummary & { fileEnc: string; fieldsEnc: string } {
    return {
      kind: row.kind,
      fileName: row.file_name,
      fileEnc: row.file_enc,
      fieldsEnc: row.fields_enc,
      varNames: JSON.parse(row.var_names),
      updatedAt: row.updated_at,
    };
  }
}

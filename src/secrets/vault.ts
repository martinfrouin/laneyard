import type { CredentialKind, CredentialStore, CredentialSummary } from "../db/credentials.js";
import type { SecretStore, SecretSummary } from "../db/secrets.js";
import { fieldsOf } from "../credentials/kinds.js";
import { scrub } from "../logs/redact.js";
import { decrypt, encrypt } from "./cipher.js";
import { loadOrCreateKey } from "./key.js";

export interface CredentialBlock {
  fileName: string;
  fileBytes: Buffer;
  fields: Record<string, string>;
  varNames: Record<string, string>;
}

/**
 * The only component that ever holds a decrypted secret.
 *
 * Everything else — the store, the API, the interface — deals in names and
 * ciphertext. Keeping plaintext to one small file is what makes "a secret never
 * reaches a log" a claim you can check by reading, rather than a hope.
 */
export class Vault {
  private constructor(
    private readonly key: Buffer,
    private readonly store: SecretStore,
    private readonly credentials: CredentialStore,
  ) {}

  static async open(home: string, store: SecretStore, credentials: CredentialStore): Promise<Vault> {
    return new Vault(await loadOrCreateKey(home), store, credentials);
  }

  async set(projectSlug: string | null, key: string, value: string, masked: boolean): Promise<void> {
    this.store.set(projectSlug, key, encrypt(value, this.key), masked);
  }

  remove(projectSlug: string | null, key: string): boolean {
    return this.store.remove(projectSlug, key);
  }

  list(projectSlug: string): SecretSummary[] {
    return this.store.list(projectSlug);
  }

  listGlobal(): SecretSummary[] {
    return this.store.listGlobal();
  }

  /**
   * What the vault holds under one project's own name — secrets and signing
   * blocks — and nothing global.
   *
   * Its own method rather than a filter over `list`, because the question is a
   * different one: `list` is "what would a run of this project see", and this is
   * "what would be left behind if the project went away". A global secret is in
   * the first answer and must never be in the second.
   */
  ownedBy(projectSlug: string): { secrets: SecretSummary[]; credentials: CredentialSummary[] } {
    return {
      secrets: this.store.listOwn(projectSlug),
      credentials: this.credentials.listOwn(projectSlug),
    };
  }

  /**
   * Forgets everything stored under one project's name.
   *
   * Part of removing a project: that act clears the vault along with the clone,
   * the artifacts and the run history, behind the one typed confirmation that
   * covers all of it. What it forgets is Laneyard's own encrypted copy — the
   * `.p8` and the keystore that went in are still wherever the user keeps them.
   *
   * Scoped by slug, so a global secret or a global signing block survives it:
   * those are read by every project and are never one project's to remove.
   */
  forget(projectSlug: string): { secrets: number; credentials: number } {
    return {
      secrets: this.store.removeAllOwn(projectSlug),
      credentials: this.credentials.removeAllOwn(projectSlug),
    };
  }

  /**
   * Removes this project's secret values from a piece of text, in one shot.
   *
   * Separate from `Redactor`, which is stateful and belongs to a live stream:
   * reusing that instance here would corrupt its buffer mid-run.
   */
  scrub(projectSlug: string, text: string): string {
    return scrub(text, this.maskedValues(projectSlug));
  }

  /**
   * Every secret that applies to a project, ready to become environment variables.
   *
   * A row that will not decrypt is skipped rather than thrown: a key that was
   * rotated or a corrupted row should cost one variable, not the whole build.
   * The run then fails on its own terms, with fastlane saying what was missing.
   */
  resolve(projectSlug: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, payload] of Object.entries(this.store.encrypted(projectSlug))) {
      try {
        out[key] = decrypt(payload, this.key);
      } catch {
        // Deliberately silent here; the interface reports unreadable secrets.
      }
    }
    return out;
  }

  /**
   * One value, in the clear — and only when it was never declared secret.
   *
   * The refusal is the point. This vault has been write-only since it was
   * written: the server never sent a value back, so the interface had nothing to
   * uncover and no browser ever held one. That is worth keeping for anything
   * anyone called a secret.
   *
   * But not everything stored here is one. `APP_VERSION`, `SENTRY_ORG`, an
   * issuer id — those are identifiers, and being unable to check what was stored
   * makes an import something you have to take on faith. The line between the
   * two already existed and is the user's own: `masked` is "keep this out of the
   * logs". A value that carries it is never returned, whoever asks.
   *
   * Returns null for an unknown key, and throws for a masked one — a caller
   * that forgot to check must fail loudly rather than leak.
   */
  reveal(projectSlug: string, key: string): string | null {
    const row = this.store.find(projectSlug, key);
    if (!row) return null;
    if (row.masked) {
      throw new Error(`${key} is kept out of the logs, so its value is never sent back.`);
    }
    return decrypt(row.valueEnc, this.key);
  }

  /** Flips whether a value is kept out of the logs, leaving the value alone. */
  setMasked(projectSlug: string | null, key: string, masked: boolean): boolean {
    return this.store.setMasked(projectSlug, key, masked);
  }

  /**
   * Stores a signing block: the file, and the fields that make it usable.
   *
   * `cipher.ts` speaks strings and a `.jks` is bytes, so the file makes the trip
   * as base64. The fields travel as one JSON object rather than one row each,
   * because a keystore missing its alias is not a block with a gap in it — it is
   * not a block.
   */
  async setCredential(
    projectSlug: string | null,
    kind: CredentialKind,
    block: { fileName: string; fileBytes: Buffer; fields: Record<string, string>; varNames: Record<string, string> },
  ): Promise<void> {
    this.credentials.set(projectSlug, kind, {
      fileName: block.fileName,
      fileEnc: encrypt(block.fileBytes.toString("base64"), this.key),
      fieldsEnc: encrypt(JSON.stringify(block.fields), this.key),
      varNames: block.varNames,
    });
  }

  /**
   * One block that applies to a project, in the clear, or undefined if there is none.
   *
   * Unlike `resolve`, an unreadable row throws. The leniency there is earned: a
   * missing variable makes fastlane stop and say which one. A block that quietly
   * fails to decrypt costs a debug-signed artifact that builds, uploads, and is
   * rejected by the store days later — by which point nobody is looking at this
   * run's log. The kind is in the message because that is the part you need to
   * know before you can act.
   */
  resolveCredential(projectSlug: string, kind: CredentialKind): CredentialBlock | undefined {
    const row = this.credentials.find(projectSlug, kind);
    if (!row) return undefined;

    try {
      return {
        fileName: row.fileName,
        fileBytes: Buffer.from(decrypt(row.fileEnc, this.key), "base64"),
        fields: JSON.parse(decrypt(row.fieldsEnc, this.key)),
        varNames: row.varNames,
      };
    } catch {
      throw new Error(
        `The stored ${kind} block cannot be decrypted. Its encryption key changed or the row is damaged; upload the credential again.`,
      );
    }
  }

  listCredentials(projectSlug: string): CredentialSummary[] {
    return this.credentials.list(projectSlug);
  }

  listGlobalCredentials(): CredentialSummary[] {
    return this.credentials.listGlobal();
  }

  removeCredential(projectSlug: string | null, kind: CredentialKind): boolean {
    return this.credentials.remove(projectSlug, kind);
  }

  /**
   * The values a run's output must not contain.
   *
   * A block's secret fields belong here as much as a masked secret does: a
   * keystore password reaches the build as an environment variable, and gradle
   * is perfectly willing to echo one back on failure.
   */
  maskedValues(projectSlug: string): string[] {
    const masked = this.store.maskedKeys(projectSlug);
    const values = Object.entries(this.resolve(projectSlug))
      .filter(([key]) => masked.has(key))
      .map(([, value]) => value);

    for (const summary of this.credentials.list(projectSlug)) {
      const block = this.resolveCredential(projectSlug, summary.kind);
      if (!block) continue;
      for (const field of fieldsOf(summary.kind)) {
        const value = block.fields[field.name];
        if (field.secret && value) values.push(value);
      }
    }
    return values;
  }
}

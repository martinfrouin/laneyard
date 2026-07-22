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

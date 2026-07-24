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

  async set(
    projectSlug: string,
    key: string,
    value: string,
    masked: boolean,
    inEnvFile = false,
  ): Promise<void> {
    this.store.set(projectSlug, key, encrypt(value, this.key), masked, inEnvFile);
  }

  remove(projectSlug: string, key: string): boolean {
    return this.store.remove(projectSlug, key);
  }

  list(projectSlug: string): SecretSummary[] {
    return this.store.list(projectSlug);
  }

  /**
   * The same listing, with the value attached wherever there is nothing to hide.
   *
   * The rule is the user's own tick box and nothing else: `masked` means "keep
   * this out of the build logs", and a value carrying it is never returned,
   * whoever asks. A value without it is printed verbatim in every log the lane
   * produces — hiding it on the one screen where you might want to check it
   * protects nothing and costs the check.
   *
   * That is why this is not `list`. Everything else in the server asks a
   * question about names — is this one stored, is that one missing — and it
   * would be a poor trade to hand all of them plaintext for it. One method, one
   * caller, and `list` stays the answer to "what is here".
   *
   * A masked value stays out even though `reveal` would now return it: a secret
   * is readable on request, one key at a time, and that is not the same as
   * putting every secret a project holds into a browser because someone opened
   * a tab.
   *
   * A row that will not decrypt loses its value and keeps its name, the same
   * leniency `resolve` takes: a rotated key should cost one line of one screen,
   * not the screen.
   */
  listWithValues(projectSlug: string): (SecretSummary & { value?: string })[] {
    return this.store.list(projectSlug).map((summary) => {
      if (summary.masked) return summary;
      try {
        const value = this.reveal(projectSlug, summary.key);
        return value === null ? summary : { ...summary, value };
      } catch {
        return summary;
      }
    });
  }

  /**
   * Forgets everything stored under one project's name.
   *
   * Part of removing a project: that act clears the vault along with the clone,
   * the artifacts and the run history, behind the one typed confirmation that
   * covers all of it. What it forgets is Laneyard's own encrypted copy — the
   * `.p8` and the keystore that went in are still wherever the user keeps them.
   *
   * There is nothing it has to leave behind. Everything a project sees is a row
   * under its own slug, so "what would a run see" and "what would be left if the
   * project went away" are now the same question — which is most of the point of
   * having one scope.
   */
  forget(projectSlug: string): { secrets: number; credentials: number } {
    return {
      secrets: this.store.removeAll(projectSlug),
      credentials: this.credentials.removeAll(projectSlug),
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
   * Every secret a project holds, ready to become environment variables.
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
   * One value, in the clear, whether or not it is masked.
   *
   * This used to refuse a masked value outright: the vault was write-only, no
   * route ever sent one back, and the secrets screen offered nothing to press.
   * The property was real and it was worth less than it looked. `masked` means
   * "keep this out of the build logs" — it is about what a run prints, and it
   * was doing double duty as "and nobody may ever look at it again", which
   * nobody asked for. A passphrase stored six months ago and now suspected of a
   * typo could only be replaced, never checked, and replacing a credential you
   * cannot read is how the wrong one gets stored twice.
   *
   * What the refusal actually bought was narrow, because everything around it
   * still holds: the screen is admin-only, one key is read per request, and a
   * masked value is still absent from `listWithValues`, so opening the page puts
   * none of them in a browser. What is gone is only the guarantee that a value
   * never leaves the server — which was never what protected it. Redaction of
   * the logs is untouched and is the property that matters.
   *
   * Returns null for an unknown key.
   */
  reveal(projectSlug: string, key: string): string | null {
    const row = this.store.find(projectSlug, key);
    if (!row) return null;
    return decrypt(row.valueEnc, this.key);
  }

  /** Flips whether a value is kept out of the logs, leaving the value alone. */
  setMasked(projectSlug: string, key: string, masked: boolean): boolean {
    return this.store.setMasked(projectSlug, key, masked);
  }

  /** Flips whether a value is written into the environment file. */
  setInEnvFile(projectSlug: string, key: string, inEnvFile: boolean): boolean {
    return this.store.setInEnvFile(projectSlug, key, inEnvFile);
  }

  /**
   * The variables that go in the environment file, in the clear, ready to be
   * rendered.
   *
   * Decrypted here rather than in the writer, so plaintext stays inside this one
   * file — the property the whole module exists to make checkable by reading.
   * A row that will not decrypt is skipped, the same leniency `resolve` takes:
   * the build then fails on its own terms rather than on a rotated key.
   */
  envFileValues(projectSlug: string): Record<string, string> {
    const wanted = new Set(this.store.envFileKeys(projectSlug));
    return Object.fromEntries(Object.entries(this.resolve(projectSlug)).filter(([key]) => wanted.has(key)));
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
    projectSlug: string,
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
   * One of a project's blocks, in the clear, or undefined if there is none.
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

  removeCredential(projectSlug: string, kind: CredentialKind): boolean {
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

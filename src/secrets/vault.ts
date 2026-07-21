import type { SecretStore, SecretSummary } from "../db/secrets.js";
import { scrub } from "../logs/redact.js";
import { decrypt, encrypt } from "./cipher.js";
import { loadOrCreateKey } from "./key.js";

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
  ) {}

  static async open(home: string, store: SecretStore): Promise<Vault> {
    return new Vault(await loadOrCreateKey(home), store);
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

  /** The values a run's output must not contain. */
  maskedValues(projectSlug: string): string[] {
    const masked = this.store.maskedKeys(projectSlug);
    return Object.entries(this.resolve(projectSlug))
      .filter(([key]) => masked.has(key))
      .map(([, value]) => value);
  }
}

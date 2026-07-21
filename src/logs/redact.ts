/** What a redacted value is replaced with. Fixed width, so it leaks no length. */
const MARKER = "••••••";

/**
 * Values shorter than this are left alone.
 *
 * A two-character secret would match constantly and turn the log into confetti
 * while hiding nothing an attacker could not guess. Refusing is more honest than
 * pretending to protect it.
 */
export const MIN_LENGTH = 4;

/**
 * Removes secret values from a stream of text.
 *
 * The difficulty is not the replacement, it is the boundaries: a pseudo-terminal
 * cuts its output wherever it likes, so a secret can arrive as `hun` then `ter2`.
 * Replacing chunk by chunk would let it through in two pieces — and the file on
 * disk would contain it in full.
 *
 * So the redactor holds back the last few characters, exactly as many as could
 * still turn out to be the beginning of a secret, and releases them only once
 * they cannot. `flush()` empties that buffer at the end of the run.
 */
/**
 * One-shot removal, for text that is not part of the live stream.
 *
 * A run's error summary is stored in the database and rendered in the interface
 * without ever passing through the stream, so it needs its own pass. Using the
 * live `Redactor` instance here would corrupt its buffer mid-run.
 */
export function scrub(text: string, values: string[]): string {
  let out = text;
  for (const value of [...new Set(values.filter((v) => v.length >= MIN_LENGTH))].sort(
    (a, b) => b.length - a.length,
  )) {
    out = out.split(value).join(MARKER);
  }
  return out;
}

export class Redactor {
  private readonly values: string[];
  private readonly longest: number;
  private held = "";

  constructor(values: string[]) {
    // Longest first: replacing "token" before "token-suffix" would leave the
    // suffix behind in the log.
    this.values = [...new Set(values.filter((v) => v.length >= MIN_LENGTH))].sort(
      (a, b) => b.length - a.length,
    );
    this.longest = this.values.reduce((max, v) => Math.max(max, v.length), 0);
  }

  private replaceAll(text: string): string {
    let out = text;
    for (const value of this.values) out = out.split(value).join(MARKER);
    return out;
  }

  /**
   * How many trailing characters could still turn into a secret.
   *
   * Holding a fixed window of `longest - 1` would be correct but wasteful: with
   * a 200-character API key in the vault, every chunk would stall its last 199
   * characters until the next one arrived, and the live terminal would lag
   * visibly. So we keep only what is genuinely ambiguous — the longest suffix
   * that is a proper prefix of some secret — which is usually nothing at all.
   */
  private ambiguousTail(text: string): number {
    const max = Math.min(this.longest - 1, text.length);
    for (let length = max; length > 0; length -= 1) {
      const suffix = text.slice(text.length - length);
      if (this.values.some((value) => value.startsWith(suffix))) return length;
    }
    return 0;
  }

  /** Takes a chunk, returns the part that is safe to write out. */
  push(chunk: string): string {
    if (this.values.length === 0) return chunk;

    const combined = this.replaceAll(this.held + chunk);
    const keep = this.ambiguousTail(combined);

    this.held = combined.slice(combined.length - keep);
    return keep === 0 ? combined : combined.slice(0, combined.length - keep);
  }

  /** Releases the tail. Call once, when the stream is over. */
  flush(): string {
    const rest = this.replaceAll(this.held);
    this.held = "";
    return rest;
  }
}

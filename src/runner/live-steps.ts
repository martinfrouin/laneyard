/**
 * Spotting of step separators in fastlane's output, during the run.
 *
 * Fragile by nature: this is text meant for humans. We therefore keep only
 * one thing from it, the byte offset where each step starts — the only
 * piece of information report.xml doesn't contain. The names and durations
 * that count come from the report at the end of the run.
 */
// Real form observed, ANSI sequences included:
//   [13:14:00]: \x1b[32m--- Step: mkdir -p ../build && echo x > y.ipa ---\x1b[0m
// The name isn't an identifier: for a `sh` action, it's the entire command,
// spaces included. The capture is therefore lazy up to the closing dashes,
// and definitely not `\S+`.
const SEPARATOR = /-{2,}\s+Step:\s*(.+?)\s+-{2,}/;

export interface LiveStep {
  name: string;
  logOffset: number;
}

export class LiveStepTracker {
  private pending = "";
  private pendingOffset = 0;
  private found: LiveStep[] = [];

  /** `offset` is the fragment's position in the log file. */
  consume(chunk: string, offset: number): void {
    if (this.pending === "") this.pendingOffset = offset;
    this.pending += chunk;

    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl);
      const lineOffset = this.pendingOffset;

      this.pendingOffset += Buffer.byteLength(this.pending.slice(0, nl + 1), "utf8");
      this.pending = this.pending.slice(nl + 1);

      const m = SEPARATOR.exec(line);
      if (m?.[1]) this.found.push({ name: m[1], logOffset: lineOffset });
    }
  }

  steps(): LiveStep[] {
    return this.found;
  }
}

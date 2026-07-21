/**
 * Extraction of a readable failure cause from a run's output.
 *
 * This is a heuristic: it knows fastlane by its display habits, not by a
 * contract. It therefore lives in this isolated module, and follows the
 * rule that applies to it — it blocks nothing, changes nothing, and only
 * produces supplementary information. The full log remains the reference.
 */

const ANSI = /\x1b\[[0-9;]*m/g;
/** Timestamp prefix that fastlane puts at the head of every line. */
const TIMESTAMP = /^\[\d{2}:\d{2}:\d{2}\]:\s*/;
/** Marker that fastlane reserves for a failure's final cause. */
const FASTLANE_ERROR = /^\[!\]\s*(.+)$/;

const NOISE = /^(fastlane finished with errors|fastlane\.tools finished)/i;
const LOOKS_LIKE_FAILURE = /error|failed|failure|échou/i;

/**
 * Renders a displayable sentence next to a failed run, or a fallback sentence.
 *
 * The order of preference follows decreasing reliability: fastlane's explicit
 * marker first, a line mentioning an error next, the exit code as a last
 * resort. The generic "fastlane finished with errors" is discarded: it is
 * always present and teaches nothing.
 */
export function summarizeFailure(log: string, exitCode: number | null): string {
  const lines = log
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(TIMESTAMP, "").trim())
    .filter((line) => line.length > 0);

  for (const line of [...lines].reverse()) {
    const marked = FASTLANE_ERROR.exec(line);
    if (marked?.[1]) return marked[1].slice(0, 500);
  }

  const mentioning = [...lines]
    .reverse()
    .find((line) => LOOKS_LIKE_FAILURE.test(line) && !NOISE.test(line));
  if (mentioning) return mentioning.slice(0, 500);

  return exitCode === null
    ? "The run failed with no usable message"
    : `fastlane stopped with exit code ${exitCode}`;
}

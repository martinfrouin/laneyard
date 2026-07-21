import { readFile } from "node:fs/promises";

export interface ReportStep {
  idx: number;
  name: string;
  durationMs: number | null;
  status: "success" | "failed";
}

// The self-closing branch comes first: fastlane writes successful actions
// as `<testcase … />` and only failed ones have a body. In the other order,
// `[^>]*` would swallow the final `/` and the lazy body would run up to the
// next `</testcase>`, merging two actions and blaming the failure on the wrong one.
const TESTCASE = /<testcase\b([^>]*?)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
// `\b` is mandatory: without it, searching for `name=` first finds the end
// of `classname=`, which fastlane systematically writes as the first attribute.
/**
 * Decodes the XML entities of an attribute value.
 *
 * Essential: a `sh` action's name contains the entire command, so it
 * readily includes a `&&` or a redirection, which the report writes as
 * `&amp;&amp;` and `&gt;`. Without decoding, the interface would display the escaping.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decodeXml = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    // An out-of-range code point would make String.fromCodePoint throw: we
    // return the entity as-is rather than crash the report reading.
    const point =
      code.startsWith("#x") || code.startsWith("#X")
        ? parseInt(code.slice(2), 16)
        : code.startsWith("#")
          ? Number(code.slice(1))
          : null;

    if (point !== null) {
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : whole;
    }
    return ENTITIES[code] ?? whole;
  });

const ATTR = (source: string, name: string): string | null => {
  const raw = new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1];
  return raw === undefined ? null : decodeXml(raw);
};

/**
 * Reads the JUnit report that fastlane writes on every run.
 * It's the authoritative source for names, order, durations, and failures.
 *
 * Returns null if the report is missing or unreadable — the normal case for
 * a cancelled, timed-out, or interrupted run, or one that failed before even
 * reaching fastlane.
 */
export async function readReport(path: string): Promise<ReportStep[] | null> {
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (!xml.includes("<testsuite")) return null;

  const steps: ReportStep[] = [];
  for (const m of xml.matchAll(TESTCASE)) {
    const attrs = m[1] ?? m[2] ?? "";
    const body = m[3] ?? "";
    const rawName = ATTR(attrs, "name");
    if (rawName === null) continue;

    // fastlane names its cases "<index>: <action>".
    const named = /^(\d+):\s*(.+)$/.exec(rawName);
    const time = ATTR(attrs, "time");

    steps.push({
      idx: named ? Number(named[1]) : steps.length,
      name: named ? named[2]!.trim() : rawName.trim(),
      durationMs: time === null ? null : Math.round(Number(time) * 1000),
      status: body.includes("<failure") ? "failed" : "success",
    });
  }

  if (steps.length === 0) return null;

  // The index comes from the name, not the position: nothing guarantees its
  // uniqueness. A report with several testsuites, or mixing numbered and
  // unnumbered cases, produces duplicates — and `run_step` has a primary key
  // (run_id, idx). So we renumber after sorting, keeping the announced order.
  return steps
    .sort((a, b) => a.idx - b.idx)
    .map((step, position) => ({ ...step, idx: position }));
}

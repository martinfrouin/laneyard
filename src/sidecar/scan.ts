import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveSidecarScript } from "./bridge.js";
import { resolvePrismRuby } from "./prism-ruby.js";

const exec = promisify(execFile);

const SCRIPT = resolveSidecarScript(dirname(fileURLToPath(import.meta.url)), "scan.rb");

/** One keyword argument the scanner can act on, and where it sits. */
export interface Literal {
  action: string;
  arg: string;
  /** `literal` is a quoted string; `env` is an `ENV[...]`/`ENV.fetch(...)` lookup. */
  kind: "literal" | "env";
  /** The string for a literal, the looked-up name for an env lookup. */
  value: string;
  /** Byte range of the literal itself, quotes included. */
  valueStart: number;
  valueLength: number;
  /** Byte range of the whole `key: value` pair. */
  pairStart: number;
  pairLength: number;
  line: number;
}

/**
 * What a Fastfile says, or null.
 *
 * **Null is an ordinary answer, never a failure.** No Ruby with Prism, no
 * Fastfile, a Fastfile that does not parse — all of them mean the same thing to
 * every caller: this file was not analysed, carry on. Setup must not fail
 * because a scan could not run; it did its job before this feature existed.
 */
export async function scanFastfile(cwd: string, fastlaneDir: string): Promise<Literal[] | null> {
  const env = await resolvePrismRuby();
  if (env === null) return null;

  try {
    const { stdout } = await exec("ruby", [SCRIPT, "--fastlane-dir", fastlaneDir], {
      cwd,
      env,
      timeout: 30_000,
    });
    const res = JSON.parse(stdout) as
      | { ok: true; literals: Record<string, unknown>[] }
      | { ok: false; error: string };
    if (!res.ok) return null;

    return res.literals.map((l) => ({
      action: String(l["action"]),
      arg: String(l["arg"]),
      kind: l["kind"] === "env" ? ("env" as const) : ("literal" as const),
      value: String(l["value"]),
      valueStart: Number(l["value_start"]),
      valueLength: Number(l["value_length"]),
      pairStart: Number(l["pair_start"]),
      pairLength: Number(l["pair_length"]),
      line: Number(l["line"]),
    }));
  } catch {
    return null;
  }
}

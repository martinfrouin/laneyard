import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RubyEnv {
  env: NodeJS.ProcessEnv;
  /** `process`: Ruby already knew. `launcher`: environment recovered from the fastlane launcher. */
  source: "process" | "launcher";
}

async function canRequireFastlane(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await exec("ruby", ["-e", 'require "fastlane"'], { env, timeout: 180_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconstructs the `fastlane` launcher's environment when it's a shell script.
 *
 * We don't run the launcher: we read back its `GEM_HOME` and `GEM_PATH`
 * assignments and have bash evaluate them, since it knows how to expand
 * `${HOME}` and default values. Deliberately narrow approach — two
 * variables, nothing else.
 */
async function envFromLauncher(): Promise<NodeJS.ProcessEnv | null> {
  const script = `
    shim=$(command -v fastlane) || exit 1
    head -c 2 "$shim" | grep -q '#!' || exit 1
    eval "$(grep -oE '(GEM_HOME|GEM_PATH)="[^"]*"' "$shim" | sed 's/^/export /')" || exit 1
    [ -n "$GEM_HOME" ] || exit 1
    printf '%s\\n%s\\n' "$GEM_HOME" "$GEM_PATH"
  `;
  try {
    const { stdout } = await exec("bash", ["-c", script], { timeout: 30_000 });
    const [gemHome, gemPath] = stdout.split("\n");
    if (!gemHome) return null;
    return { ...process.env, GEM_HOME: gemHome, GEM_PATH: gemPath || gemHome };
  } catch {
    return null;
  }
}

let cached: Promise<RubyEnv | null> | null = null;

/**
 * Finds an environment in which `ruby` can load fastlane, or null.
 *
 * The result is memoized: probing costs several seconds, since fastlane is
 * slow to load, and the install doesn't change while the process runs.
 */
export function resolveRubyEnv(): Promise<RubyEnv | null> {
  cached ??= (async () => {
    if (await canRequireFastlane(process.env)) {
      return { env: process.env, source: "process" as const };
    }
    const env = await envFromLauncher();
    if (env && (await canRequireFastlane(env))) {
      return { env, source: "launcher" as const };
    }
    return null;
  })();
  return cached;
}

/** Single message, so the problem isn't described differently in each place. */
export const FASTLANE_UNAVAILABLE =
  "Ruby cannot load fastlane. Install it for the current Ruby " +
  "(`gem install fastlane`), or declare a Gemfile in the project and set " +
  "the `runtime` setting to `bundle`.";

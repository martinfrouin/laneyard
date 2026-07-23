import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveRubyEnv } from "./ruby-env.js";

const exec = promisify(execFile);

async function canRequirePrism(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await exec("ruby", ["-e", 'require "prism"'], { env, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

let cached: Promise<NodeJS.ProcessEnv | null> | null = null;

/**
 * An environment in which `ruby` can load Prism, or null.
 *
 * Two candidates, cheapest first. `process.env` is right whenever the user's
 * shell already points at a modern Ruby, and costs milliseconds. Only when
 * that fails is `resolveRubyEnv` asked — it probes `require "fastlane"` and is
 * slow, but it finds the Ruby the project actually builds with, which is the
 * one that matters when `PATH` points somewhere else.
 *
 * Measured, and the reason this function exists rather than a bare `ruby`:
 * macOS ships 2.6 at `/usr/bin/ruby`, and Prism is a default gem only from
 * Ruby 3.3. A caller that assumed `ruby` would do would silently never find
 * anything on a machine whose shell had not been set up.
 *
 * Returns null rather than throwing. Every caller treats an absent Ruby as
 * "not analysed", never as a failure.
 */
export function resolvePrismRuby(): Promise<NodeJS.ProcessEnv | null> {
  cached ??= (async () => {
    if (await canRequirePrism(process.env)) return process.env;

    const fallback = await resolveRubyEnv();
    if (fallback && (await canRequirePrism(fallback.env))) return fallback.env;

    return null;
  })();
  return cached;
}

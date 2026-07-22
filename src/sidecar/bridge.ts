import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FASTLANE_UNAVAILABLE, resolveRubyEnv } from "./ruby-env.js";

const exec = promisify(execFile);

export type SidecarResponse =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

/**
 * Locates `ruby/introspect.rb` from wherever this module happens to live.
 *
 * Two layouts, and only trying one of them is how listing lanes came to be
 * broken in every installed copy while working perfectly from the sources:
 * `src/sidecar/` sits two levels under the package root, `dist/src/sidecar/`
 * sits three. The package ships `ruby/` at its root in both cases.
 */
export function resolveSidecarScript(moduleDir: string): string {
  const candidates = [
    join(moduleDir, "..", "..", "ruby", "introspect.rb"),
    join(moduleDir, "..", "..", "..", "ruby", "introspect.rb"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

const SCRIPT = resolveSidecarScript(dirname(fileURLToPath(import.meta.url)));

/**
 * A digest of the sidecar script, for whoever caches what it produced.
 *
 * Caching introspection on the fastlane folder's contents alone is wrong in one
 * direction that is easy to miss: the answer depends on the *reader* as much as
 * on what is read. Teaching the parser to follow a lane into the methods it
 * calls changed what a Fastfile means without changing the Fastfile, so every
 * existing install went on being served the answer from before — a Play Store
 * check reporting "no lane uploads", permanently, on a project that uploads.
 *
 * Hashing the script rather than bumping a constant is what keeps that from
 * happening again: there is nothing to remember. Read once, because the file
 * cannot change under a running process that already loaded it.
 */
let scriptDigest: string | null = null;

export function sidecarVersion(): string {
  scriptDigest ??= createHash("sha256").update(readFileSync(SCRIPT)).digest("hex").slice(0, 16);
  return scriptDigest;
}

export type Invoke = (
  command: string,
  cwd: string,
  fastlaneDir: string,
) => Promise<SidecarResponse>;

/**
 * Runs the sidecar in the project's context.
 * In `bundle` mode, the invocation goes through `bundle exec` to see the
 * right version of fastlane and the plugins the project declares.
 */
export function makeInvoke(runtime: "bundle" | "system"): Invoke {
  return async (command, cwd, fastlaneDir) => {
    const [bin, args] =
      runtime === "bundle"
        ? ["bundle", ["exec", "ruby", SCRIPT, command, "--fastlane-dir", fastlaneDir]]
        : ["ruby", [SCRIPT, command, "--fastlane-dir", fastlaneDir]];

    // In bundle mode, `bundle exec` already provides the right environment. In
    // system mode, it has to be found: depending on the install, `ruby` may not see fastlane.
    let env = process.env;
    if (runtime === "system") {
      const ruby = await resolveRubyEnv();
      if (!ruby) return { ok: false, error: FASTLANE_UNAVAILABLE };
      env = ruby.env;
    }

    try {
      const { stdout } = await exec(bin, args as string[], {
        cwd,
        env,
        timeout: 180_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(stdout) as SidecarResponse;
    } catch (cause) {
      const err = cause as { stderr?: string; message: string };
      return {
        ok: false,
        error: `The Ruby sidecar failed: ${(err.stderr || err.message).trim()}`,
      };
    }
  };
}

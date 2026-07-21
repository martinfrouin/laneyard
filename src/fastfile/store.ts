import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Checks that a freshly written Fastfile still holds up. Injected so this
 * module knows nothing about fastlane or Ruby, and its own tests need
 * neither. In production, the verifier asks the sidecar for the lanes: that
 * parses the file and lists what it found, which is exactly the two things
 * that matter here — it still parses, and the lanes are still there.
 */
export type Verify = () => Promise<VerifyResult>;

const DEFAULT_FASTLANE_DIR = "fastlane";

/**
 * Reads and writes the Fastfile byte-for-byte.
 *
 * A file written by hand must never come back mangled: no reformatting, no
 * trailing-newline fixing, no reordering. Someone may have spent a long time
 * on that file, so `write` keeps the previous content only in memory — never
 * in a sibling file, which would show up as an untracked file in the git
 * workspace and eventually get committed by someone in a hurry — and puts it
 * back the moment the injected verifier says the new content doesn't hold up.
 */
export class FastfileStore {
  async read(workspacePath: string, fastlaneDir = DEFAULT_FASTLANE_DIR): Promise<string> {
    return readFile(this.resolvePath(workspacePath, fastlaneDir), "utf8");
  }

  /**
   * Writes `content` verbatim, then verifies it. On failure, the previous
   * content is written back before returning, so the workspace never lands
   * between the old file and the new one.
   */
  async write(
    workspacePath: string,
    content: string,
    verify: Verify,
    fastlaneDir = DEFAULT_FASTLANE_DIR,
  ): Promise<VerifyResult> {
    const path = this.resolvePath(workspacePath, fastlaneDir);
    const previous = await readFile(path, "utf8");

    await writeFile(path, content, "utf8");
    const result = await verify();
    if (!result.ok) {
      // Whatever broke, the file on disk goes back to exactly what it was
      // before this call — a stray backup file would be a second thing to
      // clean up and forget about.
      await writeFile(path, previous, "utf8");
    }
    return result;
  }

  /**
   * Resolves the Fastfile's path, refusing to leave the workspace.
   *
   * `fastlaneDir` comes from configuration — the project's own
   * `laneyard.yml`, or the server's `config.yml` — and a value like
   * `../../etc` must not turn an editor into a way to write anywhere on the
   * machine.
   */
  private resolvePath(workspacePath: string, fastlaneDir: string): string {
    const root = resolve(workspacePath);
    const full = resolve(root, fastlaneDir, "Fastfile");
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`fastlane_dir resolves outside the workspace: ${fastlaneDir}`);
    }
    return full;
  }
}

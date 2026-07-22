import { chmod, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { defaultVarNames } from "../credentials/kinds.js";
import type { Vault } from "../secrets/vault.js";

export interface MaterialisedCredentials {
  /** Variables to merge into the run's environment. */
  env: Record<string, string>;
  /** Removes everything that was written. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Turns the stored signing blocks into real files, for the length of one run.
 *
 * A keystore has no string form. Gradle's `storeFile` is a path, `sign_apk`
 * wants a path, `app_store_connect_api_key` wants a path — so a block that
 * exists only as ciphertext in SQLite cannot be used by anything, and something
 * has to put bytes on a disk. This is that something, and the files it writes
 * live exactly as long as the run does.
 *
 * The variable names are the project's, never Laneyard's. A Fastfile written
 * around `ENV["ASC_KEY_FILEPATH"]` is not a Fastfile doing it wrong, and asking
 * it to rename anything would make Laneyard a thing projects adapt to. So the
 * name stored with the block is the only name exported: no default is emitted
 * alongside it as a courtesy, because that courtesy is what makes a typo in the
 * configured name look like it worked.
 *
 * **Every applicable block is materialised, whether or not the lane looks like
 * it needs it.** Narrowing this to what a lane appears to use is tempting: it
 * would shrink the window a private key spends unencrypted on disk, which is
 * the one cost this module carries. It is not worth it. Detection reads a
 * Fastfile that can call anything through `sh`, a plugin, or a lane in another
 * file; a detector that guesses "not needed" and guesses wrong turns a build
 * that worked into a build that fails — or worse, into a debug-signed artifact
 * that ships. Detection decides what Laneyard *asks* for, never what it
 * withholds at run time.
 *
 * A block that will not decrypt throws, and the run never starts. That is the
 * same trade `Vault.resolveCredential` makes and for the same reason: an
 * absent signing key is not a missing variable fastlane will name for you, it
 * is an artifact that builds, uploads, and is rejected by the store days later.
 */
export async function materialiseCredentials(
  vault: Vault,
  projectSlug: string,
  runSecretsDir: string,
): Promise<MaterialisedCredentials> {
  const env: Record<string, string> = {};
  const cleanup = async (): Promise<void> => {
    await rm(runSecretsDir, { recursive: true, force: true });
    // And the `runs/<run id>` folder that held it, so a server does not
    // accumulate one empty directory per build it has ever run. `rmdir` rather
    // than `rm -r`: it refuses a folder that still has something in it, which
    // is exactly the protection wanted for a path this function did not create.
    await rmdir(dirname(runSecretsDir)).catch(() => {});
  };

  // The mode is applied explicitly rather than trusted to `mkdir`: the mode
  // argument is masked by the process umask, and a server started from a shell
  // with a lax umask would otherwise hand out a world-readable key directory.
  await mkdir(runSecretsDir, { recursive: true });
  await chmod(runSecretsDir, 0o700);

  try {
    for (const summary of vault.listCredentials(projectSlug)) {
      const block = vault.resolveCredential(projectSlug, summary.kind);
      if (!block) continue;

      const defaults = defaultVarNames(summary.kind);
      const names = { ...defaults, ...block.varNames };

      // One directory per kind, so the original file name survives intact.
      // Some tools read meaning from it — `AuthKey_<KEY ID>.p8` is a convention
      // fastlane's own docs use — and flattening two blocks into one directory
      // would let a `.p8` and a service account JSON that happen to share a name
      // overwrite each other, silently, on the run that used both.
      const dir = join(runSecretsDir, summary.kind);
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o700);

      // `basename` because the name came from an upload and has never been
      // constrained: a stored `../../id_rsa` must land in this directory, not
      // over something in the user's home.
      const path = join(dir, basename(block.fileName) || summary.kind);
      await writeFile(path, block.fileBytes, { mode: 0o600 });
      await chmod(path, 0o600);

      env[names["path"] ?? defaults["path"]!] = path;
      for (const [field, value] of Object.entries(block.fields)) {
        const name = names[field];
        // A field with no name is a block stored before that field existed;
        // dropping it beats exporting it under a name nobody agreed on.
        if (name && value) env[name] = value;
      }
    }
  } catch (cause) {
    // Nothing may survive a partial materialisation: the blocks that did get
    // written are as sensitive as the one that failed, and the caller's
    // `cleanup` is never reached when this function throws.
    await cleanup();
    throw cause;
  }

  return { env, cleanup };
}

import { stat } from "node:fs/promises";

/**
 * Refuses a missing fastlane directory with a sentence instead of an ENOENT.
 *
 * The raw error read `ENOENT: no such file or directory, scandir
 * '…/workspaces/popotheque-app/fastlane'` — technically accurate and no help at
 * all, because the interesting part is *why* it was looking there.
 *
 * It is nearly always the same story: the configured fastlane folder is in the
 * working copy setup ran against, but not in the clone Laneyard builds from. A
 * folder only present locally — never committed, not yet pushed, or gitignored
 * — does not reach the clone, and neither does a `laneyard.yml` that would
 * point at it until it too is committed and pushed.
 */
export async function assertFastlaneDir(dir: string, configured: string): Promise<void> {
  const found = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (found) return;

  throw new Error(
    `No ${configured}/ in the clone. Laneyard builds from a clone of the remote, ` +
      "so a fastlane folder that exists only in your working copy — uncommitted, " +
      "unpushed, or gitignored — never reaches it. Commit and push it, or set " +
      "`fastlane_dir` on the project's block in config.yml.",
  );
}

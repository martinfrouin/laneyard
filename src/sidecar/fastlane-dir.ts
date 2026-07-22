import { stat } from "node:fs/promises";

/**
 * Refuses a missing fastlane directory with a sentence instead of an ENOENT.
 *
 * The raw error read `ENOENT: no such file or directory, scandir
 * '…/workspaces/popotheque-app/fastlane'` — technically accurate and no help at
 * all, because the interesting part is *why* it was looking there.
 *
 * It is nearly always the same story. `laneyard setup` writes `laneyard.yml`
 * into the working copy, and Laneyard builds from a clone of the remote, so the
 * file that says where fastlane lives does not reach the clone until it is
 * committed and pushed. Until then `fastlane_dir` falls back to `fastlane`,
 * which in a monorepo is not where anything is.
 */
export async function assertFastlaneDir(dir: string, configured: string): Promise<void> {
  const found = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (found) return;

  throw new Error(
    `No ${configured}/ in the clone. Laneyard builds from a clone of the remote, ` +
      "so `laneyard.yml` only takes effect once it is committed and pushed — " +
      "until then this falls back to `fastlane`. Push it, or set `fastlane_dir` " +
      "on the project's block in config.yml.",
  );
}

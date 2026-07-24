import { stat } from "node:fs/promises";
import { join } from "node:path";

const isDirectory = async (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

/**
 * Refuses a missing fastlane directory with a sentence instead of an ENOENT.
 *
 * The raw error read `ENOENT: no such file or directory, scandir
 * '…/workspaces/popotheque-app/fastlane'` — technically accurate and no help at
 * all, because the interesting part is *why* it was looking there.
 *
 * Two stories, and they need different sentences. **The workspace may not exist
 * at all**: nothing has been cloned yet, which is the ordinary state of a project
 * between `laneyard setup` and its first run. Telling that one it forgot to push
 * sent people through their git history looking for a problem they did not have.
 *
 * Otherwise the clone is there without the folder, and it is nearly always the
 * same story: the configured fastlane folder is in the working copy setup ran
 * against, but not in the clone Laneyard builds from — never committed, not yet
 * pushed, or gitignored.
 */
export async function assertFastlaneDir(workspacePath: string, configured: string): Promise<void> {
  if (await isDirectory(join(workspacePath, configured))) return;

  if (!(await isDirectory(workspacePath))) {
    throw new Error(
      `${configured}/ cannot be read yet: this project has not been cloned. ` +
        "Laneyard clones the repository on the project's first run — start one, " +
        "and the Fastfile is readable from then on.",
    );
  }

  throw new Error(
    `No ${configured}/ in the clone. Laneyard builds from a clone of the remote, ` +
      "so a fastlane folder that exists only in your working copy — uncommitted, " +
      "unpushed, or gitignored — never reaches it. Commit and push it, or set " +
      "`fastlane_dir` on the project's block in config.yml.",
  );
}

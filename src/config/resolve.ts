import { projectSettingsSchema } from "./schema.js";
import type { ProjectEntry, ProjectSettings, RepoConfig } from "./schema.js";

export type Origin = "repo" | "server" | "default";
export type Provenance = Record<keyof ProjectSettings, Origin>;

const SETTING_KEYS = Object.keys(projectSettingsSchema.shape) as (keyof ProjectSettings)[];

/**
 * Prefixes an app-relative path with the app directory.
 *
 * `.` (or an empty prefix) is the repository root, and a path there is already
 * repo-root-relative — nothing to add.
 */
function underApp(appRoot: string, p: string): string {
  return appRoot === "" || appRoot === "." ? p : `${appRoot}/${p}`;
}

/**
 * Reads an app-level `laneyard.yml` as if it had been written at the repository
 * root.
 *
 * The file declares its paths relative to its own directory —
 * `fastlane_dir: fastlane`, `artifact_globs: ['**​/*.aab']` — so an app moved or
 * duplicated keeps its file unchanged. But everything downstream resolves paths
 * as repo-root-relative (`join(workspacePath, …)`, globs with `cwd:
 * workspacePath`). So the app-relativity is collapsed here, once, at the
 * boundary: the two path fields are prefixed with the app directory before the
 * merge ever sees them, and nothing past this point learns a new rule.
 *
 * Only the path fields move. `platforms`, `runtime`, `timeout_minutes`,
 * `interactive_default`, `required_secrets` and `retention` are not paths and
 * pass through untouched. A root-level file is never handed here: its paths are
 * already repo-root-relative.
 */
export function normaliseAppConfig(repo: RepoConfig, appRoot: string): RepoConfig {
  const out: RepoConfig = { ...repo };
  if (repo.fastlane_dir !== undefined) {
    out.fastlane_dir = underApp(appRoot, repo.fastlane_dir);
  }
  if (repo.artifact_globs !== undefined) {
    out.artifact_globs = repo.artifact_globs.map((g) => underApp(appRoot, g));
  }
  return out;
}

/**
 * Merges the three sources field by field.
 * `undefined` means "not set"; any other value, including an empty array
 * or `false`, is an explicit decision by the user.
 */
export function resolveProjectSettings(
  entry: ProjectEntry,
  repo: RepoConfig | null,
): { settings: ProjectSettings; provenance: Provenance } {
  const chosen: Record<string, unknown> = {};
  const provenance = {} as Provenance;

  for (const key of SETTING_KEYS) {
    const fromRepo = repo?.[key];
    const fromServer = (entry as Record<string, unknown>)[key];

    if (fromRepo !== undefined) {
      chosen[key] = fromRepo;
      provenance[key] = "repo";
    } else if (fromServer !== undefined) {
      chosen[key] = fromServer;
      provenance[key] = "server";
    } else {
      provenance[key] = "default";
    }
  }

  // The schema applies the defaults for anything still absent.
  const settings = projectSettingsSchema.parse(chosen);
  return { settings, provenance };
}

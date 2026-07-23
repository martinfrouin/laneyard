import { watch } from "node:fs";
import { loadRepoConfig, loadServerConfig } from "./load.js";
import { normaliseAppConfig, resolveProjectSettings } from "./resolve.js";
import type { Origin } from "./resolve.js";
import type { ProjectEntry, ProjectSettings, RepoConfig, ServerConfig } from "./schema.js";
import { appRootOf } from "../heuristics/platforms.js";
import { join } from "node:path";

export interface ResolvedProject {
  entry: ProjectEntry;
  settings: ProjectSettings;
  provenance: Record<keyof ProjectSettings, Origin>;
}

/**
 * The server's live configuration.
 *
 * Safety rule: an invalid configuration never replaces a valid one. The
 * server keeps running with what it had, and the error is exposed to the
 * interface — never a half-configured startup.
 */
export class ConfigStore {
  private config: ServerConfig | null = null;
  private error: string | null = null;

  constructor(private readonly path: string) {}

  async load(): Promise<{ ok: boolean; error?: string }> {
    const res = await loadServerConfig(this.path);
    if (!res.ok) {
      this.error = res.error;
      return { ok: false, error: res.error };
    }
    this.config = res.config;
    this.error = null;
    return { ok: true };
  }

  /** Watches the file and reloads, absorbing bursts of events. */
  watch(onReload: (ok: boolean) => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(this.path, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void this.load().then((r) => onReload(r.ok));
      }, 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  }

  /**
   * The file this store reads.
   *
   * Exposed because removing a project edits that very file: the route would
   * otherwise have to rebuild the path from the data root and hope the two
   * agree, which is exactly the kind of duplicated assumption that drifts.
   */
  configPath(): string {
    return this.path;
  }

  server(): ServerConfig["server"] | null {
    return this.config?.server ?? null;
  }

  projects(): ProjectEntry[] {
    return this.config?.projects ?? [];
  }

  project(slug: string): ProjectEntry | null {
    return this.projects().find((p) => p.slug === slug) ?? null;
  }

  lastError(): string | null {
    return this.error;
  }

  /**
   * Resolves a project's effective settings by reading its workspace's
   * laneyard.yml if it exists. The workspace may not be cloned yet: we
   * then fall back to the project's block and the defaults.
   *
   * The file is looked for in two places, in order:
   *
   * 1. `<workspace>/<appRoot>/laneyard.yml` — the app-level file, its paths
   *    relative to the app's own directory, so a monorepo of N apps carries N
   *    of them. Normalised back to repo-root-relative before the merge.
   * 2. `<workspace>/laneyard.yml` — the repository-root file, repo-root-relative,
   *    which is what existing installs have and keeps working unchanged.
   *
   * `appRoot` is derived from the project's `fastlane_dir` as declared in
   * `config.yml` — the server-side anchor, present for every monorepo project by
   * necessity and what points at the app before any repo file is read. When it is
   * the repository root (the default `fastlane`), the two locations coincide and
   * nothing changes.
   */
  async resolve(slug: string, workspacePath: string): Promise<ResolvedProject | null> {
    const entry = this.project(slug);
    if (!entry) return null;

    const appRoot = appRootOf(entry.fastlane_dir);

    let repo: RepoConfig | null = null;
    if (appRoot !== ".") {
      const appRes = await loadRepoConfig(join(workspacePath, appRoot, "laneyard.yml"));
      if (appRes.ok) repo = normaliseAppConfig(appRes.config, appRoot);
    }
    if (repo === null) {
      const rootRes = await loadRepoConfig(join(workspacePath, "laneyard.yml"));
      repo = rootRes.ok ? rootRes.config : null;
    }

    const { settings, provenance } = resolveProjectSettings(entry, repo);
    return { entry, settings, provenance };
  }
}

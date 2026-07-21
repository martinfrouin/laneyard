import { watch } from "node:fs";
import { loadRepoConfig, loadServerConfig } from "./load.js";
import { resolveProjectSettings } from "./resolve.js";
import type { Origin } from "./resolve.js";
import type { ProjectEntry, ProjectSettings, ServerConfig } from "./schema.js";
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
   */
  async resolve(slug: string, workspacePath: string): Promise<ResolvedProject | null> {
    const entry = this.project(slug);
    if (!entry) return null;

    const repoRes = await loadRepoConfig(join(workspacePath, "laneyard.yml"));
    const repo = repoRes.ok ? repoRes.config : null;

    const { settings, provenance } = resolveProjectSettings(entry, repo);
    return { entry, settings, provenance };
  }
}

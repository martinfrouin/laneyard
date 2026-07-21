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
 * La configuration vivante du serveur.
 *
 * Règle de sûreté : une configuration invalide ne remplace jamais une configuration
 * valide. Le serveur continue de tourner avec ce qu'il avait, et l'erreur est
 * exposée à l'interface — jamais de démarrage à moitié configuré.
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

  /** Surveille le fichier et recharge, en absorbant les rafales d'événements. */
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
   * Résout les réglages effectifs d'un projet en lisant le laneyard.yml de son
   * workspace s'il existe. Le workspace peut ne pas encore être cloné : on
   * retombe alors sur le bloc du projet et les défauts.
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

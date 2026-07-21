import { projectSettingsSchema } from "./schema.js";
import type { ProjectEntry, ProjectSettings, RepoConfig } from "./schema.js";

export type Origin = "repo" | "server" | "default";
export type Provenance = Record<keyof ProjectSettings, Origin>;

const SETTING_KEYS = Object.keys(projectSettingsSchema.shape) as (keyof ProjectSettings)[];

/**
 * Fusionne les trois sources champ par champ.
 * `undefined` signifie « non défini » ; toute autre valeur, y compris un tableau vide
 * ou `false`, est une décision explicite de l'utilisateur.
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

  // Le schéma applique les défauts pour tout ce qui reste absent.
  const settings = projectSettingsSchema.parse(chosen);
  return { settings, provenance };
}

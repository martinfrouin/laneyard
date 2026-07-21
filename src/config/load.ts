import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import { repoConfigSchema, serverConfigSchema } from "./schema.js";
import type { RepoConfig, ServerConfig } from "./schema.js";

export type LoadResult<T> = { ok: true; config: T } | { ok: false; error: string };

/** Lit et valide un fichier YAML. N'échoue jamais par exception : l'appelant décide. */
async function loadYamlFile<T>(path: string, schema: ZodType<T, any, any>): Promise<LoadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    return { ok: false, error: `Lecture impossible de ${path} : ${(cause as Error).message}` };
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (cause) {
    return { ok: false, error: `YAML invalide dans ${path} : ${(cause as Error).message}` };
  }

  const parsed = schema.safeParse(data ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`)
      .join(" ; ");
    return { ok: false, error: `Configuration invalide dans ${path} — ${details}` };
  }
  return { ok: true, config: parsed.data };
}

export async function loadServerConfig(path: string): Promise<LoadResult<ServerConfig>> {
  const res = await loadYamlFile(path, serverConfigSchema);
  if (!res.ok) return res;

  const seen = new Set<string>();
  for (const p of res.config.projects) {
    if (seen.has(p.slug)) {
      return { ok: false, error: `Configuration invalide dans ${path} — slug en double : ${p.slug}` };
    }
    seen.add(p.slug);
  }

  // Le nom affiché retombe sur le slug plutôt que d'être optionnel partout en aval.
  const projects = res.config.projects.map((p) => ({ ...p, name: p.name ?? p.slug }));
  return { ok: true, config: { ...res.config, projects } };
}

export async function loadRepoConfig(path: string): Promise<LoadResult<RepoConfig>> {
  return loadYamlFile(path, repoConfigSchema);
}

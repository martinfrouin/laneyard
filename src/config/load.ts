import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import { repoConfigSchema, serverConfigSchema } from "./schema.js";
import type { RepoConfig, ServerConfig } from "./schema.js";

export type LoadResult<T> = { ok: true; config: T } | { ok: false; error: string };

/** Reads and validates a YAML file. Never fails by throwing: the caller decides. */
async function loadYamlFile<T>(path: string, schema: ZodType<T, any, any>): Promise<LoadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    return { ok: false, error: `Could not read ${path}: ${(cause as Error).message}` };
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (cause) {
    return { ok: false, error: `Invalid YAML in ${path}: ${(cause as Error).message}` };
  }

  const parsed = schema.safeParse(data ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Invalid configuration in ${path} — ${details}` };
  }
  return { ok: true, config: parsed.data };
}

export async function loadServerConfig(path: string): Promise<LoadResult<ServerConfig>> {
  const res = await loadYamlFile(path, serverConfigSchema);
  if (!res.ok) return res;

  const seen = new Set<string>();
  for (const p of res.config.projects) {
    if (seen.has(p.slug)) {
      return { ok: false, error: `Invalid configuration in ${path} — duplicate slug: ${p.slug}` };
    }
    seen.add(p.slug);
  }

  // The display name falls back to the slug rather than being optional everywhere downstream.
  const projects = res.config.projects.map((p) => ({ ...p, name: p.name ?? p.slug }));
  return { ok: true, config: { ...res.config, projects } };
}

export async function loadRepoConfig(path: string): Promise<LoadResult<RepoConfig>> {
  return loadYamlFile(path, repoConfigSchema);
}

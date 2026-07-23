import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import { repoConfigSchema, serverConfigSchema } from "./schema.js";
import type { RepoConfig, ServerConfig, UserEntry } from "./schema.js";

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

/**
 * Validates the declared accounts.
 *
 * Every refusal here is a locked room avoided: a server with no account, or
 * with none that can administer it, is one nobody can fix from the interface.
 */
function normaliseUsers(server: {
  users?: UserEntry[] | undefined;
}): { ok: true; users: UserEntry[] } | { ok: false; error: string } {
  const { users } = server;

  if (users === undefined) {
    return {
      ok: false,
      error: "server.users is missing — without an account nobody can log in.",
    };
  }

  if (users.length === 0) {
    return { ok: false, error: "server.users is empty — declare at least one admin account." };
  }

  const seen = new Set<string>();
  for (const u of users) {
    if (seen.has(u.name)) {
      return { ok: false, error: `duplicate user: ${u.name}` };
    }
    seen.add(u.name);
  }

  if (!users.some((u) => u.role === "admin")) {
    return {
      ok: false,
      error: "server.users has no admin — a server nobody can administer is a locked room.",
    };
  }

  return { ok: true, users };
}

export async function loadServerConfig(path: string): Promise<LoadResult<ServerConfig>> {
  const res = await loadYamlFile(path, serverConfigSchema);
  if (!res.ok) return res;

  const accounts = normaliseUsers(res.config.server);
  if (!accounts.ok) {
    return { ok: false, error: `Invalid configuration in ${path} — ${accounts.error}` };
  }

  const seen = new Set<string>();
  for (const p of res.config.projects) {
    if (seen.has(p.slug)) {
      return { ok: false, error: `Invalid configuration in ${path} — duplicate slug: ${p.slug}` };
    }
    seen.add(p.slug);
  }

  // The display name falls back to the slug rather than being optional everywhere downstream.
  const projects = res.config.projects.map((p) => ({ ...p, name: p.name ?? p.slug }));

  return { ok: true, config: { server: { ...res.config.server, users: accounts.users }, projects } };
}

export async function loadRepoConfig(path: string): Promise<LoadResult<RepoConfig>> {
  return loadYamlFile(path, repoConfigSchema);
}

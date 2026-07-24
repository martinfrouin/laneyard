import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { parseDocument, YAMLMap, YAMLSeq } from "yaml";
import { serializeYaml } from "./yaml.js";

/**
 * Sets or clears a project's `env_file`, in `config.yml`, leaving the rest of
 * the file alone.
 *
 * The setting is configuration, so it lives in a file — that is what makes
 * backing Laneyard up a matter of copying one. But it is also the only way to
 * turn the environment file on, and a feature reachable exclusively by editing
 * YAML by hand is one nobody finds. So the screen writes the file, the way the
 * accounts screen already writes accounts and the removal screen already
 * removes a project's block.
 *
 * A `laneyard.yml` in the repository still wins, unchanged: that precedence is
 * the same for every setting, and this function is not the place to invent an
 * exception to it. The screen reports it rather than offering to fight it.
 *
 * Returns false when no project carries that slug, so the caller can answer 404
 * rather than rewrite the file to say what it already said.
 */
export async function setEnvFileSetting(
  path: string,
  slug: string,
  envFile: string | null,
): Promise<boolean> {
  const doc = parseDocument(await readFile(path, "utf8"));
  const projects = doc.get("projects");
  if (!(projects instanceof YAMLSeq)) return false;

  const entry = projects.items.find(
    (item) => item instanceof YAMLMap && item.get("slug") === slug,
  ) as YAMLMap | undefined;
  if (!entry) return false;

  if (envFile === null) entry.delete("env_file");
  else entry.set("env_file", envFile);

  await writeFile(path, serializeYaml(doc), "utf8");
  return true;
}

/**
 * Why this path cannot be used, or null.
 *
 * The same rule the schema enforces at load, applied here so a bad value is
 * refused by the screen that typed it rather than accepted and then reported as
 * a broken configuration on the next reload. The file holds the values the vault
 * exists to protect, and a path climbing out of the app would let it be dropped
 * anywhere on the server.
 */
export function envFileProblem(envFile: string): string | null {
  if (envFile === "") return "A path is required.";
  if (isAbsolute(envFile)) return "A path inside the app, not an absolute one.";
  const clean = normalize(envFile);
  if (clean === ".." || clean.startsWith("../") || clean.startsWith("..\\")) {
    return "A path inside the app, not one that climbs out of it.";
  }
  return null;
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnvExample } from "../heuristics/env-example.js";
import type { LaneUses } from "../heuristics/readiness.js";

/**
 * What a project needs from its environment, and what it is still missing.
 *
 * One computation, used twice: the readiness checklist turns it into a
 * sentence, and the secrets screen turns it into a form with the names already
 * filled in. Two copies of this would be free to disagree, and the screen that
 * disagreed would be the one telling someone to store a variable the checklist
 * had stopped asking for.
 *
 * Names only, from three places, none of which is a `.env`:
 *
 * - every `ENV.fetch("…")` a lane reaches, including through the methods it
 *   calls — the Fastfile saying what it reads;
 * - a committed `.env.example`, which is the conventional manifest of exactly
 *   this and catches what no parse can find: `sentry-cli` wants
 *   `SENTRY_AUTH_TOKEN` and no lane ever names it;
 * - `required_secrets` in `laneyard.yml`, for whatever neither covers.
 *
 * A value is never read from any of them. `.env.example` holds placeholders by
 * definition, and the file that holds real values is the one that never reaches
 * a clone — which is the whole problem, not a source.
 */
export interface RequiredSecrets {
  /** Everything the lanes need, sorted. */
  required: string[];
  /** Those neither in the vault nor in the server's own environment. */
  missing: string[];
}

export async function requiredSecrets(input: {
  lanes: LaneUses[];
  declared: string[];
  workspacePath: string;
  fastlaneDir: string;
  vaultKeys: string[];
  serverEnv: string[];
}): Promise<RequiredSecrets> {
  const fromExample = await envExampleNames(input.workspacePath, input.fastlaneDir);
  const required = [
    ...new Set([...input.lanes.flatMap((l) => l.env ?? []), ...input.declared, ...fromExample]),
  ].sort();

  const inVault = new Set(input.vaultKeys);
  const inServer = new Set(input.serverEnv);

  return {
    required,
    missing: required.filter((name) => !inVault.has(name) && !inServer.has(name)),
  };
}

/**
 * The names a committed `.env.example` advertises, if there is one.
 *
 * Two conventional filenames and no more: a convenience for the common case,
 * not a search. Never throws — an absent file is the ordinary situation and
 * means "nothing declared", not a failure.
 */
export async function envExampleNames(
  workspacePath: string,
  fastlaneDir: string,
): Promise<string[]> {
  const names: string[] = [];
  for (const file of [".env.example", ".env.sample"]) {
    const text = await readFile(join(workspacePath, fastlaneDir, file), "utf8").catch(() => null);
    if (text !== null) names.push(...parseEnvExample(text));
  }
  return names;
}

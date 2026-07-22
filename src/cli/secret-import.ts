import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnvExample } from "../heuristics/env-example.js";
import type { Vault } from "../secrets/vault.js";

/**
 * Bringing an existing `fastlane/.env` into the vault.
 *
 * Every project that already builds has its variables somewhere, and that
 * somewhere is almost always `fastlane/.env` — gitignored, on one laptop, and
 * therefore absent from the clone a build server works from. Typing eight
 * values into a web form to reproduce a file that is already on disk is a poor
 * way to start, and the sort of chore where one typo costs an evening.
 *
 * This runs from the CLI and not from the server on purpose: the `.env` exists
 * where the working copy is, and the server only ever sees a clone.
 *
 * Values are never printed, never logged, and never passed as arguments. What
 * the command shows is names.
 */

/**
 * The variables whose value is a *path*, and the name their *contents* belong
 * under.
 *
 * This is the translation that makes an import worth doing. `SUPPLY_JSON_KEY`
 * points at a service account JSON on this laptop; copied verbatim into the
 * vault it would point at nothing on the build machine, and the run would fail
 * exactly as it does today. What has to travel is the file, so the file is
 * read and stored under `SUPPLY_JSON_KEY_DATA` — a name supply reads on its
 * own, verified against fastlane 2.237.
 *
 * There is no such entry for a `.p8`. `APP_STORE_CONNECT_API_KEY_P8` was one —
 * an earlier version of this interface invented it, no action in fastlane has
 * ever declared it, and the interface has since dropped it. See `P8_PATH_NAMES`
 * for what a `.p8` path becomes instead.
 */
export const PATH_TO_CONTENTS: Record<string, string> = {
  SUPPLY_JSON_KEY: "SUPPLY_JSON_KEY_DATA",
  GOOGLE_APPLICATION_CREDENTIALS: "SUPPLY_JSON_KEY_DATA",
};

/**
 * Variables that name a `.p8` the way projects and this interface's own
 * earlier version did.
 *
 * None of them is a name fastlane reads: the App Store Connect action takes
 * its key from `key_id`, `issuer_id` and a file, not from an environment
 * variable an import could invent on its own. What this command can do
 * honestly is find the file and say where it belongs — an App Store Connect
 * key block, uploaded from the secrets tab with the two fields the file alone
 * cannot supply.
 */
export const P8_PATH_NAMES = new Set([
  "ASC_KEY_FILEPATH",
  "APP_STORE_CONNECT_API_KEY_PATH",
  "APP_STORE_CONNECT_API_KEY_FILEPATH",
]);

/** What an import proposes to do to one variable, before anything is written. */
export interface Planned {
  /** The name it will be stored under — not always the name it was read under. */
  key: string;
  /** The name in the `.env`, when the two differ. */
  from?: string;
  /**
   * How it was resolved, which is the whole of what the user needs to check.
   * `suggest-block` is the one kind nothing is stored for: the `.p8` it names
   * is real, but the destination is a credential block, not a vault entry.
   */
  kind: "value" | "file-contents" | "unresolved-path" | "suggest-block";
  /** The path a file was read from, for the ones that came from a file. */
  path?: string;
  value: string;
}

export interface ImportPlan {
  planned: Planned[];
  /** Names already in the vault, which an import would replace. */
  replacing: string[];
}

/**
 * Reads a `.env` into a name → value map.
 *
 * Shares `parseEnvExample`'s idea of what a line is, and adds the values, which
 * that one deliberately drops. Quotes are stripped because a `.env` written by
 * hand often has them and fastlane's own dotenv strips them too — a value that
 * silently kept its quotes is a credential that never works, with nothing on
 * screen to say why.
 */
export function parseEnvFile(content: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const name of parseEnvExample(content)) {
    // Re-scan for this name's value; `parseEnvExample` already vouched for the
    // name, so this only has to find the last assignment, the way dotenv does.
    for (const raw of content.split("\n")) {
      const line = raw.trim().replace(/^export\s+/, "");
      const eq = line.indexOf("=");
      if (eq <= 0 || line.slice(0, eq).trim() !== name) continue;

      let value = line.slice(eq + 1).trim();
      const quoted = /^(["'])(.*)\1$/.exec(value);
      if (quoted) value = quoted[2]!;
      out.set(name, value);
    }
  }

  return out;
}

/**
 * Decides what would be stored, without storing anything.
 *
 * Separate from the writing so the command can show its work first. An import
 * that reads eight files and writes eight secrets before saying a word is one
 * nobody can check.
 */
export async function planImport(
  env: Map<string, string>,
  cwd: string,
  existingKeys: string[],
): Promise<ImportPlan> {
  const planned: Planned[] = [];
  const already = new Set(existingKeys);

  for (const [name, value] of env) {
    if (value === "") continue;

    if (P8_PATH_NAMES.has(name)) {
      const path = isAbsolute(value) ? value : resolve(cwd, value);
      const found = await access(path)
        .then(() => true)
        .catch(() => false);

      if (!found) {
        // Same handling as any other missing file: reported, not skipped in
        // silence, because it is the credential the project most needs.
        planned.push({ key: name, kind: "unresolved-path", path, value });
        continue;
      }

      // The file is real, but nothing is stored under `name` — there is
      // nowhere fastlane would read it from. Left to the caller to say what
      // to do instead, in the same voice as the rest of the plan.
      planned.push({ key: name, kind: "suggest-block", path, value });
      continue;
    }

    const contentsKey = PATH_TO_CONTENTS[name];
    if (contentsKey) {
      const path = isAbsolute(value) ? value : resolve(cwd, value);
      const contents = await readFile(path, "utf8").catch(() => null);

      if (contents === null) {
        // Named a file that is not there. Reported rather than skipped: it is
        // the credential the project most needs, and silence would read as
        // success.
        planned.push({ key: name, kind: "unresolved-path", path, value });
        continue;
      }

      planned.push({
        key: contentsKey,
        ...(contentsKey === name ? {} : { from: name }),
        kind: "file-contents",
        path,
        value: contents,
      });
      continue;
    }

    planned.push({ key: name, kind: "value", value });
  }

  return {
    planned,
    replacing: planned
      .filter((p) => p.kind !== "unresolved-path" && p.kind !== "suggest-block" && already.has(p.key))
      .map((p) => p.key),
  };
}

/**
 * Writes the plan into the vault.
 *
 * Everything is masked. A value that came out of a `.env` is a credential by
 * assumption — that is what the file is for — and the one that turns out not to
 * be secret costs a redacted line in a log, while the reverse costs a leak.
 */
export async function applyImport(
  vault: Vault,
  slug: string | null,
  plan: ImportPlan,
): Promise<number> {
  let stored = 0;
  for (const item of plan.planned) {
    if (item.kind === "unresolved-path" || item.kind === "suggest-block") continue;
    await vault.set(slug, item.key, item.value, true);
    stored += 1;
  }
  return stored;
}

/** Where a project's `.env` files live, in the order dotenv itself reads them. */
export function envFilesIn(fastlaneDir: string): string[] {
  return [join(fastlaneDir, ".env.default"), join(fastlaneDir, ".env")];
}

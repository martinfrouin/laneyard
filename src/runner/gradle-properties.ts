import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { findAndroidBuild } from "../heuristics/android-root.js";

/**
 * The file the build already asks for, supplied rather than demanded.
 *
 * `heuristics/android-signing.ts` describes the trap: the Flutter documentation
 * ships a release build that falls back to the debug signing config when
 * `key.properties` is absent, and gitignores that file. On a build server it is
 * therefore always absent, the release build succeeds, and the `.aab` is signed
 * with the debug key.
 *
 * The obvious fix is to tell the user to rewrite their build script. Laneyard
 * does not do that — the project never adapts to Laneyard. So it writes the file
 * the script is already looking for, for the length of one run, and only where
 * its absence would ship a debug-signed artifact.
 *
 * **The property names are a convention, not a reading.** `conditionalOn` gave
 * the file's *name*, because that is what appears in the script; the keys inside
 * it are read somewhere else entirely, usually through a `Properties` object
 * indexed by string. The four defaults below are the Flutter documentation's,
 * which is why they are right most of the time and never certain. A project
 * reading `keystoreProperties["alias"]` says so in the block's `property_names`
 * setting — asking at configuration time is allowed; requiring a repository
 * change is not.
 *
 * This is the one credential written into the persistent clone, because Gradle
 * resolves the path relative to the build rather than to anything a run owns.
 * Three guards earn that:
 *
 *  1. The first line is a marker, and Laneyard removes a marked file at the end
 *     of the run and sweeps for one again at the start of the next, so a process
 *     killed mid-build cannot leave passwords in a working tree indefinitely.
 *  2. A file without the marker is never written over and never removed. It is
 *     the user's own — possibly their real signing configuration — and clobbering
 *     it would be far worse than any warning Laneyard could print.
 *  3. Readiness must not read this file back and report the project ready
 *     because of something Laneyard wrote. That is enforced elsewhere; nothing
 *     here may make it impossible, which is the other reason for the marker.
 */
export const LANEYARD_MARKER = "# written by laneyard, do not commit";

/**
 * The keys the Flutter documentation uses, in the order `property_names` lists
 * them. The setting is a plain comma-separated list because that is the form a
 * user can correct in one keystroke: the field arrives pre-filled with exactly
 * these four, and a project that reads `alias` edits the fourth one.
 */
const DEFAULT_PROPERTY_NAMES = ["storeFile", "storePassword", "keyPassword", "keyAlias"];

/** Where each of those four names gets its value from. */
const SLOTS = ["storeFile", "store_password", "key_password", "key_alias"] as const;

export interface KeystoreBlock {
  /** Absolute path of the keystore materialised for this run — see `materialise.ts`. */
  storeFile: string;
  /** The block's stored fields, `property_names` and `properties_path` included. */
  fields: Record<string, string>;
}

/**
 * Where the file goes, or null when nobody can say.
 *
 * The configured path wins outright: it exists precisely because detection
 * cannot always tell, and a setting the user corrected must not be second-
 * guessed by the guess it corrected. It is read relative to the app root, the
 * same root the build script was found under, and a path climbing out of it is
 * refused rather than followed — the value came from a form, and a run must not
 * be able to drop a file with passwords in it anywhere on the server.
 *
 * Otherwise the parser's answer decides, and `unknown` means the file is not
 * written at all. Writing it in the likelier of two directories would be worse
 * than writing nothing: the build would go on signing with the debug key while
 * a file sat next to it looking like the problem had been dealt with.
 */
async function locate(root: string, fields: Record<string, string>): Promise<string | null> {
  const build = await findAndroidBuild(root);
  // The build makes no such bet — or there is no android build here at all — so
  // nothing is at stake and nothing is written. Checked even when the path was
  // configured by hand: the setting says where the file would go, never that it
  // is wanted, and a project that has since fixed its build script should stop
  // being written into without having to remember to clear a field.
  if (!build || !build.facts.releaseCanUseDebugKey) return null;

  const configured = (fields["properties_path"] ?? "").trim();
  if (configured !== "") {
    const path = resolve(root, normalize(configured));
    const inside = relative(root, path);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
    return path;
  }

  if (build.facts.conditionalOn === null) return null;
  const { name, scope } = build.facts.conditionalOn;
  if (scope === "root") return join(build.gradleRoot, name);
  if (scope === "module") return join(build.moduleDir, name);
  return null;
}

/** The first line of a file, or null when there is no file to read. */
async function firstLine(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  return text === null ? null : (text.split("\n")[0] ?? "");
}

/**
 * Java `.properties` escaping, applied to values only.
 *
 * A backslash is an escape character in that format, and the store path ends in
 * a file name that came from an upload — so a value can genuinely contain one.
 * Newlines are escaped rather than dropped: a password truncated at a line break
 * would produce a file Gradle reads happily and signs wrongly with.
 */
function escapeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

/**
 * The names to write, positionally overridden by the block's setting.
 *
 * Exported because the readiness check names them on screen: what Laneyard is
 * going to write into someone's build is not something to leave implicit, and
 * the check must read the same list the writer does rather than a copy of it.
 */
export function propertyNames(fields: Record<string, string>): string[] {
  const configured = (fields["property_names"] ?? "").split(",").map((n) => n.trim());
  return DEFAULT_PROPERTY_NAMES.map((fallback, i) => configured[i] || fallback);
}

/**
 * Writes the properties file, and returns its path — or null, having written
 * nothing.
 *
 * Null is the ordinary outcome, and there are four ways to reach it: no keystore
 * block applies, the build does not fall back to the debug key, nobody could say
 * where the file goes, or a file is already there that Laneyard did not write.
 * Only the last of those is worth a word to the user, and it is the checklist's
 * word to say, not the runner's.
 */
export async function writeGradleProperties(
  root: string,
  keystore: KeystoreBlock | undefined,
): Promise<string | null> {
  if (!keystore) return null;

  const path = await locate(root, keystore.fields);
  if (path === null) return null;

  // Guard two. Anything already there without the marker is the user's, and the
  // build using it is the correct outcome — their real signing configuration
  // beats the one Laneyard would have assembled.
  const existing = await firstLine(path);
  if (existing !== null && existing.trimEnd() !== LANEYARD_MARKER) return null;

  const names = propertyNames(keystore.fields);
  const values = SLOTS.map((slot) =>
    slot === "storeFile" ? keystore.storeFile : (keystore.fields[slot] ?? ""),
  );

  const body = names
    .map((name, i) => `${name}=${escapeValue(values[i]!)}`)
    .join("\n");

  await mkdir(dirname(path), { recursive: true });
  // The mode is set twice deliberately, as in `materialise.ts`: `writeFile`'s
  // mode is masked by the process umask and ignored outright for a file that
  // already exists, and this one holds a signing password.
  await writeFile(path, `${LANEYARD_MARKER}\n${body}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/**
 * Removes a file this run wrote, and only such a file.
 *
 * Called from the run's `finally`, beside the removal of the run's secrets
 * directory, so a keystore password does not outlive the build that needed it.
 * Takes null so the caller can hand it whatever `writeGradleProperties`
 * returned without a branch of its own.
 */
export async function removeGradleProperties(path: string | null): Promise<void> {
  if (path === null) return;
  if ((await firstLine(path))?.trimEnd() !== LANEYARD_MARKER) return;
  await rm(path, { force: true }).catch(() => {});
}

/**
 * Removes a marked file left where this run would write one.
 *
 * A run killed between writing the file and reaching its `finally` — an
 * unplugged server, a `kill -9`, a container that lost its node — leaves
 * passwords in a working tree that is kept between runs. Nothing at that moment
 * can clean up after itself, so the next run does it before doing anything else.
 *
 * Silent about everything: a workspace that was never cloned has nothing to
 * sweep, and a sweep that failed must not be the reason a build did not start.
 */
export async function sweepGradleProperties(
  root: string,
  keystore: KeystoreBlock | undefined,
): Promise<void> {
  // Deliberately not conditional on there being a block. The leftover to remove
  // is from a *previous* run, and a keystore deleted since then would otherwise
  // make the file that run wrote permanent — the one arrangement in which
  // nothing would ever come back to clean it up.
  const path = await locate(root, keystore?.fields ?? {}).catch(() => null);
  await removeGradleProperties(path).catch(() => {});
}

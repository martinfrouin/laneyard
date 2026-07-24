/**
 * The environment file a build reads from disk.
 *
 * A project's own `.env` — the one its app reads, not the one fastlane reads —
 * is gitignored, and Laneyard builds from a clone, so it is never there. The
 * vault does not answer that on its own: a stored secret becomes an environment
 * variable of the run, which is enough for fastlane and enough for a Fastfile
 * that forwards values itself, and no use at all to anything that reads a
 * *file*. `flutter_dotenv` bundles `.env` as an asset,
 * `--dart-define-from-file=config.json` reads a path at compile time, an
 * `.xcconfig` is a file by definition. None of them looks at the environment,
 * and none of them fails loudly — they produce an app configured with nothing.
 *
 * So the variables a project ticks are rendered into a file at the path its
 * `laneyard.yml` names, for the length of one run, and removed afterwards. The
 * ticking decides membership of this file and nothing else: a ticked secret
 * still reaches the run as an environment variable like every other one.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LANEYARD_MARKER } from "./gradle-properties.js";

/**
 * Whether a value can be written bare.
 *
 * Anything outside this set is quoted. The set is deliberately narrow — a bare
 * line is a convenience, and being wrong about it costs a value silently read
 * back short. `#` starts a comment, whitespace at either end is trimmed by most
 * readers, and a quote or backslash is an escape somebody has to interpret.
 */
const BARE = /^[A-Za-z0-9_./:@+-]*$/;

/**
 * Escapes a value for a double-quoted dotenv line.
 *
 * Backslash first, or every escape this function then writes would be escaped
 * again by its own output. Newlines become `\n` rather than being written
 * literally: a line break inside a value ends the line, and the parser reads a
 * truncated value and a second variable that does not exist. A private key
 * pasted into a variable is where that happens for real.
 */
function escape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/**
 * Renders variables as dotenv text.
 *
 * Sorted by name, so a diff between two runs shows what changed rather than
 * what moved. Pure, and tested against a parser rather than against itself:
 * the property worth having is "a reader gets back what went in", and a test
 * written against this function's own idea of the format would pass however
 * wrong that idea was.
 */
export function renderDotenv(values: Record<string, string>): string {
  return Object.keys(values)
    .sort()
    .map((key) => dotenvLine(key, values[key]!))
    .join("");
}

/**
 * One `KEY=value` line, quoted if the value needs it.
 *
 * Exported for the preview the secrets screen shows, which renders a stand-in
 * for every masked value rather than the value. It has to compose its own lines
 * — a row of dots is not ASCII, so it would come back quoted, and the quotes
 * would be a claim about the real value that nobody can check. It still goes
 * through this function for everything it does show, so the preview and the
 * file cannot drift apart in how they write a line.
 */
export function dotenvLine(key: string, value: string): string {
  return `${key}=${BARE.test(value) ? value : `"${escape(value)}"`}\n`;
}

/** The first line of a file, or null when there is no file to read. */
async function firstLine(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  return text === null ? null : (text.split("\n")[0] ?? "");
}

/** Whether this file is one Laneyard wrote, and may therefore replace or remove. */
async function ours(path: string): Promise<boolean> {
  const line = await firstLine(path);
  return line === null || line.trimEnd() === LANEYARD_MARKER;
}

/**
 * Writes the environment file, and returns its path — or null, having written
 * nothing.
 *
 * Null has two causes and neither is an error: the project names no `env_file`,
 * or a file is already there that Laneyard did not write. That second one is
 * the important guard. The path points into a clone the user can work in by
 * hand, and a `.env` they put there themselves is their build's real
 * configuration — overwriting it would replace something that works with
 * something assembled from a checklist. It is left exactly as it is.
 *
 * The marker is the first line, so the file says what it is to anyone who opens
 * it, and so this function can tell its own output from a person's on the next
 * run. `#` is a comment in dotenv, which is the reason dotenv is the only
 * format for now: JSON has nowhere to put a line like this.
 */
export async function writeEnvFile(
  appRoot: string,
  envFile: string | undefined,
  values: Record<string, string>,
): Promise<string | null> {
  if (envFile === undefined) return null;

  const path = join(appRoot, envFile);
  if (!(await ours(path))) return null;

  await mkdir(dirname(path), { recursive: true });
  // The mode is set twice, as in `materialise.ts` and `gradle-properties.ts`:
  // `writeFile`'s mode is masked by the process umask, and ignored outright for
  // a file that already exists. This one holds whatever the vault held.
  await writeFile(path, `${LANEYARD_MARKER}\n${renderDotenv(values)}`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/**
 * Removes a file this run wrote, and only such a file.
 *
 * Called from the run's `finally`, so the values do not outlive the build that
 * needed them. Takes null so the caller can hand it whatever `writeEnvFile`
 * returned without a branch of its own.
 */
export async function removeEnvFile(path: string | null): Promise<void> {
  if (path === null) return;
  if ((await firstLine(path))?.trimEnd() !== LANEYARD_MARKER) return;
  await rm(path, { force: true }).catch(() => {});
}

/**
 * Removes a marked file left where this run would write one.
 *
 * A run killed between writing the file and reaching its `finally` — an
 * unplugged server, a `kill -9` — leaves values in a working tree that is kept
 * between runs. Nothing at that moment can clean up after itself, so the next
 * run does it first.
 *
 * Silent about everything: a workspace that was never cloned has nothing to
 * sweep, and a sweep that failed must not be the reason a build did not start.
 */
export async function sweepEnvFile(appRoot: string, envFile: string | undefined): Promise<void> {
  if (envFile === undefined) return;
  await removeEnvFile(join(appRoot, envFile)).catch(() => {});
}

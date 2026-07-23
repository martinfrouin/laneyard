import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/**
 * What Laneyard writes into its home, and the folders it fills as it runs.
 *
 * Named in one place because three commands read them — `uninstall` removes all
 * of it, `reset` removes the data but keeps the accounts and the key, and each
 * has to agree with the others about what "Laneyard's own" means.
 */

/** The three files SQLite keeps for one WAL database. */
export const DB_FILES = ["laneyard.db", "laneyard.db-wal", "laneyard.db-shm"];

/** The files Laneyard owns in its home. */
export const OWN_FILES = ["config.yml", "key", ...DB_FILES];

/** The folders Laneyard fills: clones, artifacts, logs, per-run scratch. */
export const OWN_FOLDERS = ["workspaces", "artifacts", "logs", "runs"];

/**
 * The shape the destructive CLI commands share: a line to read for the typed
 * confirmation, and two streams to write to.
 */
export interface CommandIo {
  stdin: Readable;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Reads one line, which works the same whether it is typed or piped in. */
export async function readLine(stdin: Readable): Promise<string> {
  const rl = createInterface({ input: stdin });
  try {
    for await (const line of rl) return line.trim();
    return "";
  } finally {
    rl.close();
  }
}

/**
 * Removes named entries under `home`, and returns the names it actually removed.
 *
 * A missing entry is skipped rather than reported, so a caller can hand in the
 * full list without first checking which parts are there. `rm` with `recursive`
 * and `force` handles a file and a whole folder alike.
 */
export async function removePaths(home: string, names: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const name of names) {
    const path = join(home, name);
    if ((await stat(path).catch(() => null)) === null) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

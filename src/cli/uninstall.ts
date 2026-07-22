import Database from "better-sqlite3";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { parse } from "yaml";
import { bad, bold, dim, field, heading, ok, warn } from "./style.js";

export const UNINSTALL_USAGE = `laneyard uninstall [--dry-run]

Removes Laneyard's data folder: the configuration, the vault key, the database,
the workspaces, the artifacts and the logs. It does not remove the npm package —
a command cannot sensibly delete the binary it is running from — and it prints
the command that does.

  laneyard uninstall --dry-run   list what is there and stop

There is no npm lifecycle hook doing any of this on \`npm uninstall\`, on
purpose: a package manager must not delete someone's signing keys on its own,
and a lifecycle script cannot ask.
`;

/**
 * Same shape as `laneyard secret set` and `laneyard user add`, minus their
 * `interactive` flag: those two refuse a terminal because a secret typed at a
 * prompt lands in the shell's history. Here the answer is a folder path that is
 * printed on the line above, so a terminal is exactly where it belongs.
 */
export interface UninstallIo {
  stdin: Readable;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** What one of Laneyard's folders holds. */
export interface FolderTally {
  name: string;
  path: string;
  /** Direct children — workspaces, artifact folders, log files. */
  entries: number;
  bytes: number;
}

/** What the vault holds, or why it could not be read. */
export interface VaultTally {
  projectSecrets: number;
  globalSecrets: number;
  projectBlocks: number;
  globalBlocks: number;
  runs: number;
}

/**
 * Everything in the data folder, read from disk.
 *
 * Read rather than assumed, and read before anything is touched. A command that
 * says "this will remove your artifacts" and turns out to mean four gigabytes
 * has not told anyone anything; a command that guessed the counts would be
 * worse still, because the one number that matters here — how many credentials
 * are about to become unrecoverable — is the one nobody can check afterwards.
 */
export interface Inventory {
  home: string;
  exists: boolean;
  config: { path: string; bytes: number; projects: string[] } | null;
  key: { path: string; bytes: number } | null;
  db: { path: string; bytes: number; vault: VaultTally | null; unreadable: string | null } | null;
  folders: FolderTally[];
  /**
   * Files in the folder that Laneyard did not put there. Named and left alone:
   * `$LANEYARD_HOME` may point at a directory someone else also uses, and this
   * command removes what it recognises rather than everything it finds.
   */
  strangers: string[];
  /** Everything above, added up. */
  bytes: number;
}

/** What Laneyard writes into its home, and nothing else. */
const OWN_FILES = ["config.yml", "key", "laneyard.db", "laneyard.db-wal", "laneyard.db-shm"];
const OWN_FOLDERS = ["workspaces", "artifacts", "logs", "runs"];

export async function readInventory(home: string): Promise<Inventory> {
  const empty: Inventory = {
    home,
    exists: false,
    config: null,
    key: null,
    db: null,
    folders: [],
    strangers: [],
    bytes: 0,
  };

  const here = await stat(home).catch(() => null);
  if (here === null || !here.isDirectory()) return empty;

  const present = new Set((await readdir(home).catch(() => [])) as string[]);

  const configPath = join(home, "config.yml");
  const configBytes = await sizeOf(configPath);
  const config =
    configBytes === null
      ? null
      : { path: configPath, bytes: configBytes, projects: await projectsIn(configPath) };

  const keyPath = join(home, "key");
  const keyBytes = await sizeOf(keyPath);
  const key = keyBytes === null ? null : { path: keyPath, bytes: keyBytes };

  const dbPath = join(home, "laneyard.db");
  const dbBytes = await sizeOf(dbPath);
  const db =
    dbBytes === null
      ? null
      : {
          path: dbPath,
          // The write-ahead log is part of the database, not a stray file: a row
          // written a second ago may live only there. Counted with it so the
          // size on screen is the size on disk.
          bytes: dbBytes + ((await sizeOf(`${dbPath}-wal`)) ?? 0) + ((await sizeOf(`${dbPath}-shm`)) ?? 0),
          ...(await readVault(dbPath)),
        };

  const folders: FolderTally[] = [];
  for (const name of OWN_FOLDERS) {
    const path = join(home, name);
    const tally = await tallyFolder(path);
    if (tally !== null) folders.push({ name, path, ...tally });
  }

  const strangers = [...present]
    .filter((name) => !OWN_FILES.includes(name) && !OWN_FOLDERS.includes(name))
    .sort();

  return {
    home,
    exists: true,
    config,
    key,
    db,
    folders,
    strangers,
    bytes:
      (config?.bytes ?? 0) +
      (key?.bytes ?? 0) +
      (db?.bytes ?? 0) +
      folders.reduce((sum, f) => sum + f.bytes, 0),
  };
}

/**
 * Counts what the vault holds, without writing a byte.
 *
 * Opened read-only rather than through `openDatabase`: that one applies the
 * schema and switches on the write-ahead log, both of which are writes, and
 * `--dry-run` promises not to make one.
 *
 * Read-only is not quite enough on its own. SQLite needs a `-shm` beside a WAL
 * database, and it creates one to open it even for reading — so the two are
 * noted before and removed again after if they were not there. They are scratch
 * files with nothing of anyone's in them, and removing what we made is what
 * lets the promise be a real one. A server that is running has them open
 * already, so they exist beforehand and are never touched.
 *
 * The counts are read rather than skipped over: the number of stored
 * credentials is exactly the wrong thing to guess at. When the database cannot
 * be opened at all, that is reported instead, in its own words.
 */
async function readVault(dbPath: string): Promise<{ vault: VaultTally | null; unreadable: string | null }> {
  const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];
  const ours = await Promise.all(
    sidecars.map(async (path) => ((await stat(path).catch(() => null)) === null ? path : null)),
  );

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const count = (sql: string): number =>
      (db!.prepare(sql).get() as { n: number }).n;
    return {
      vault: {
        // The empty slug is how a global row is stored — the same convention
        // `SecretStore` and `CredentialStore` use, and the reason the two are
        // counted apart: a global secret belongs to every project.
        projectSecrets: count("SELECT COUNT(*) AS n FROM secret WHERE project_slug != ''"),
        globalSecrets: count("SELECT COUNT(*) AS n FROM secret WHERE project_slug = ''"),
        projectBlocks: count("SELECT COUNT(*) AS n FROM credential WHERE project_slug != ''"),
        globalBlocks: count("SELECT COUNT(*) AS n FROM credential WHERE project_slug = ''"),
        runs: count("SELECT COUNT(*) AS n FROM run"),
      },
      unreadable: null,
    };
  } catch (cause) {
    return { vault: null, unreadable: (cause as Error).message };
  } finally {
    db?.close();
    for (const path of ours) {
      if (path !== null) await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

/** The slugs config.yml declares, or none if it cannot be read. */
async function projectsIn(path: string): Promise<string[]> {
  try {
    const doc = parse(await readFile(path, "utf8")) as { projects?: { slug?: string }[] } | null;
    return (doc?.projects ?? []).map((p) => p?.slug ?? "?").filter((s) => s !== "");
  } catch {
    return [];
  }
}

async function sizeOf(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  return info === null || !info.isFile() ? null : info.size;
}

/**
 * A folder's direct children, and the total size of everything under it.
 *
 * Only regular files count. A symlink is followed by nothing here — a clone is
 * perfectly capable of holding a link to somewhere enormous that this command
 * is not going to remove, and counting the target would report a size that is
 * not the size of what goes.
 */
async function tallyFolder(path: string): Promise<{ entries: number; bytes: number } | null> {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isDirectory()) return null;
  const children = await readdir(path).catch(() => []);
  return { entries: children.length, bytes: await sizeUnder(path) };
}

/**
 * Every regular file under a folder, added up.
 *
 * `readdir` with file types answers from the directory entry itself, so a
 * symlink is neither a file nor a directory here and is skipped — which is the
 * behaviour wanted: `rm` will remove the link, not what it points at, and the
 * size on screen has to be the size of what actually goes.
 */
async function sizeUnder(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let bytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) bytes += await sizeUnder(join(path, entry.name));
    else if (entry.isFile()) {
      const info = await stat(join(path, entry.name)).catch(() => null);
      bytes += info?.size ?? 0;
    }
  }
  return bytes;
}

/** Sizes in the units a person reads, not in bytes. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const plural = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`;

/** English, not a rule: "entry" does not take an `s`. */
const entries = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;

/** The inventory, as it appears on screen. Shared by the dry run and the real one. */
export function renderInventory(inv: Inventory): string {
  let out = heading("laneyard uninstall");
  out += field("home", inv.home) + "\n";
  out += field("total", humanSize(inv.bytes)) + "\n";

  out += heading("configuration");
  if (inv.config === null) {
    out += field("config.yml", dim("not there")) + "\n";
  } else {
    out += field("config.yml", `${inv.config.path}  ${dim(humanSize(inv.config.bytes))}`) + "\n";
    out +=
      field(
        "projects",
        inv.config.projects.length === 0 ? dim("none declared") : inv.config.projects.join(", "),
      ) + "\n";
  }

  out += heading("the vault");
  out += field("key", inv.key === null ? dim("not there") : inv.key.path) + "\n";
  if (inv.db === null) {
    out += field("database", dim("not there")) + "\n";
  } else {
    out += field("database", `${inv.db.path}  ${dim(humanSize(inv.db.bytes))}`) + "\n";
    if (inv.db.vault === null) {
      out +=
        field("contents", dim("could not be read")) + "\n" +
        dim(`               ${inv.db.unreadable ?? "unknown reason"}\n`) +
        dim("               Stop the server and run this again to see what is in it.\n");
    } else {
      const v = inv.db.vault;
      out += field("secrets", `${plural(v.projectSecrets, "project secret")}`) + "\n";
      // Said on its own line and in words rather than folded into the number
      // above: a global secret is read by every project on this machine, and
      // "in scope" is the fact someone needs before they answer the question.
      out +=
        field(
          "",
          v.globalSecrets === 0
            ? dim("no global secret")
            : `${plural(v.globalSecrets, "global secret")} — shared by every project, ${bold("removed too")}`,
        ) + "\n";
      out += field("signing", `${plural(v.projectBlocks, "project signing block")}`) + "\n";
      out +=
        field(
          "",
          v.globalBlocks === 0
            ? dim("no global signing block")
            : `${plural(v.globalBlocks, "global signing block")} — shared by every project, ${bold("removed too")}`,
        ) + "\n";
      out += field("history", plural(v.runs, "run")) + "\n";
    }
  }

  out += heading("on disk");
  if (inv.folders.length === 0) {
    out += dim("  nothing: no workspace was ever cloned and no run ever produced anything.\n");
  }
  for (const folder of inv.folders) {
    out +=
      field(
        folder.name,
        folder.entries === 0
          ? dim("empty")
          : `${entries(folder.entries)}  ${dim(humanSize(folder.bytes))}`,
      ) + "\n";
    out += dim(`               ${folder.path}\n`);
  }

  if (inv.strangers.length > 0) {
    out += heading("not Laneyard's");
    out += dim("  These are in the folder and were not put there by Laneyard. They are left\n");
    out += dim("  where they are, and the folder is left with them.\n\n");
    for (const name of inv.strangers) out += `  ${join(inv.home, name)}\n`;
  }

  return out;
}

/**
 * The one paragraph this command exists to make sure someone reads.
 *
 * Everything else here is recoverable: a config.yml can be written again by
 * `laneyard setup`, a workspace re-cloned, an artifact rebuilt. The key cannot.
 * It is a random 32 bytes that exists in one place, and every stored value is
 * ciphertext without it — so a backup of `laneyard.db` alone restores nothing.
 */
export function renderIrreversible(inv: Inventory): string {
  const v = inv.db?.vault;
  const stored = v === undefined || v === null ? null : v.projectSecrets + v.globalSecrets + v.projectBlocks + v.globalBlocks;

  return (
    heading("what cannot be undone") +
    warn(`The vault key is the one thing here that has no other copy.\n`) +
    dim("  Every secret and every signing block is encrypted under " + (inv.key?.path ?? join(inv.home, "key")) + ".\n") +
    dim("  Once it is gone, laneyard.db is ciphertext nobody can read — restoring a backup\n") +
    dim("  of the database alone will not bring anything back.\n") +
    (stored === null || stored === 0
      ? ""
      : dim(`  ${plural(stored, "stored value")} ${stored === 1 ? "goes" : "go"} with it.\n`)) +
    "\n" +
    dim("  The originals are yours and are untouched: the .p8 in your downloads, the\n") +
    dim("  keystore in your safe, the passwords in your password manager. It is Laneyard's\n") +
    dim("  copy that is unrecoverable — you will upload them again from wherever you keep\n") +
    dim("  them. If you do not know where that is, stop here and go and find out.\n") +
    "\n" +
    dim("  Your repositories are untouched. Nothing outside " + inv.home + " is read or written.\n")
  );
}

/** Reads one line, which works the same whether it is typed or piped in. */
async function readLine(stdin: Readable): Promise<string> {
  const rl = createInterface({ input: stdin });
  try {
    for await (const line of rl) return line.trim();
    return "";
  } finally {
    rl.close();
  }
}

/**
 * Entry point for `laneyard uninstall`.
 *
 * Inventory, then the one irreversible thing, then a typed confirmation, then
 * the removal. In that order and never any other: a question asked before the
 * numbers are on screen is a question nobody can answer.
 */
export async function runUninstallCommand(
  home: string,
  args: string[],
  io: UninstallIo,
): Promise<number> {
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run" || arg === "-n") dryRun = true;
    else {
      // Deliberately no `--keep-runs`, no `--yes`, no `--force`. Every one of
      // them is a way to run this without reading it, which is the only thing
      // standing between someone and an unrecoverable signing key. Keeping the
      // run history without its database is not a thing that exists anyway.
      io.err(`Unknown option: ${arg}\n\n${UNINSTALL_USAGE}`);
      return 1;
    }
  }

  const inv = await readInventory(home);
  if (!inv.exists) {
    io.out(
      `${dim(`No data folder at ${home}. There is nothing for Laneyard to remove.`)}\n\n` +
        removalHint(),
    );
    return 0;
  }

  io.out(renderInventory(inv));
  io.out(renderIrreversible(inv));

  if (dryRun) {
    io.out(
      "\n" +
        dim("Nothing was removed. Run `laneyard uninstall` without --dry-run to remove it.") +
        "\n\n" +
        removalHint(),
    );
    return 0;
  }

  // Typed in full, not `y`. A `y/n` is answered by a reflex; this is the one
  // command in the product that destroys credentials, and the path is what
  // proves the person read which folder is about to go — it is not always
  // ~/.laneyard, and $LANEYARD_HOME is exactly the case where a reflex is wrong.
  io.out(
    "\n" +
      bold("Type the path of the folder to remove, exactly, to confirm:") + "\n" +
      `  ${inv.home}\n` +
      "\n> ",
  );
  const answer = await readLine(io.stdin);

  if (answer !== inv.home) {
    io.err(
      "\n" +
        bad(
          answer === ""
            ? "Nothing was typed, so nothing was removed."
            : "That is not the path, so nothing was removed.",
        ) +
        "\n",
    );
    return 1;
  }

  const removed: string[] = [];
  for (const name of [...OWN_FILES, ...OWN_FOLDERS]) {
    const path = join(home, name);
    if ((await stat(path).catch(() => null)) === null) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }

  // The folder itself only when there is nothing left in it. Anything Laneyard
  // did not write is somebody's, and this command has no business deciding
  // otherwise — `$LANEYARD_HOME` can point anywhere.
  const left = (await readdir(home).catch(() => [])) as string[];
  if (left.length === 0) await rm(home, { recursive: true, force: true }).catch(() => undefined);

  io.out(
    heading("removed") +
      ok(`${entries(removed.length)}, ${humanSize(inv.bytes)} freed.\n`) +
      (left.length === 0
        ? dim(`  ${home} is gone.\n`)
        : dim(`  ${home} is kept: ${plural(left.length, "file")} in it ${left.length === 1 ? "is" : "are"} not Laneyard's.\n`)) +
      "\n" +
      removalHint(),
  );
  return 0;
}

/**
 * The package is still installed, and this cannot be the thing that removes it.
 *
 * A process cannot sensibly delete the binary it is running from, and a command
 * that tried would leave someone with a half-removed install and no way to ask
 * about it. So it says what to type instead — the whole command, so it can be
 * copied rather than remembered.
 */
function removalHint(): string {
  return (
    dim("The npm package is still installed. Laneyard does not remove its own binary:\n") +
    `  ${bold("npm uninstall -g laneyard")}\n` +
    dim("(installed from source with `npm link`? `npm unlink -g laneyard`.)\n")
  );
}

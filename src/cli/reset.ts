import { existsSync } from "node:fs";
import { join } from "node:path";
import { clearProjectsInConfig } from "./setup.js";
import type { CommandIo } from "./home.js";
import { DB_FILES, OWN_FOLDERS, readLine, removePaths } from "./home.js";
import { humanSize, readInventory } from "./uninstall.js";
import type { Inventory } from "./uninstall.js";
import { bad, bold, dim, field, heading, ok, warn } from "./style.js";

export const RESET_USAGE = `laneyard reset [--dry-run]

Wipes Laneyard's data — every project, the database, the workspaces, the
artifacts and the logs — and keeps the accounts and the vault key. A reset that
does not lock you out: you sign in with the same names, and older database
backups stay readable because the key they were encrypted under is still there.

  laneyard reset --dry-run   show what would go and stop

It keeps the \`server:\` block of config.yml (accounts, port, bind, retention)
and ~/.laneyard/key. It never touches the git remotes or the credential
originals — those were never Laneyard's.
`;

const plural = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`;
const entries = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;

/** The inventory, in reset's own framing: what goes, and what stays. */
function renderInventory(inv: Inventory): string {
  let out = heading("laneyard reset");
  out += field("home", inv.home) + "\n";

  out += heading("what will be wiped");
  const projects = inv.config?.projects ?? [];
  out += field("projects", projects.length === 0 ? dim("none declared") : projects.join(", ")) + "\n";

  const v = inv.db?.vault ?? null;
  if (v === null) {
    out += field("database", inv.db === null ? dim("not there") : dim("could not be read")) + "\n";
  } else {
    out += field("secrets", plural(v.secrets, "secret")) + "\n";
    out += field("signing", plural(v.blocks, "signing block")) + "\n";
    out += field("history", plural(v.runs, "run")) + "\n";
  }

  if (inv.folders.length === 0) {
    out += field("on disk", dim("nothing cloned, nothing built")) + "\n";
  }
  for (const folder of inv.folders) {
    out +=
      field(
        folder.name,
        folder.entries === 0 ? dim("empty") : `${entries(folder.entries)}  ${dim(humanSize(folder.bytes))}`,
      ) + "\n";
  }

  out += heading("what will be kept");
  // Said plainly, because these are the two facts that make a reset a reset and
  // not an uninstall: the door is not locked behind you, and the old backups are
  // not turned into ciphertext nobody can read.
  out += field("accounts", inv.config === null ? dim("none") : "left as they are — you sign in with the same names") + "\n";
  out += field("vault key", (inv.key?.path ?? join(inv.home, "key")) + " — kept, so older database backups stay readable") + "\n";
  out += "\n";
  out += dim("  The git remotes and your credential originals were never Laneyard's, and are not touched.\n");

  return out;
}

/**
 * Entry point for `laneyard reset`.
 *
 * Inventory first, then the typed confirmation, then the wipe — the order
 * `uninstall` uses, and never any other: a question asked before the numbers are
 * on screen is one nobody can answer. Unlike `uninstall`, the accounts and the
 * key stay, so the confirmation guards a reset, not a lock-out.
 */
export async function runResetCommand(home: string, args: string[], io: CommandIo): Promise<number> {
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run" || arg === "-n") dryRun = true;
    else {
      io.err(`Unknown option: ${arg}\n\n${RESET_USAGE}`);
      return 1;
    }
  }

  const inv = await readInventory(home);
  if (!inv.exists) {
    io.out(dim(`No data folder at ${home}. There is nothing to reset.`) + "\n");
    return 0;
  }

  io.out(renderInventory(inv));

  if (dryRun) {
    io.out("\n" + dim("Nothing was removed. Run `laneyard reset` without --dry-run to wipe it.") + "\n");
    return 0;
  }

  // The folder's path, exactly, not `y` — the same gate as `uninstall`. A reset
  // is less final than an uninstall, but it still throws away every run anyone
  // ever kept, and `$LANEYARD_HOME` is exactly the case where a reflex is wrong.
  io.out(
    "\n" +
      bold("Type the path of the folder to reset, exactly, to confirm:") + "\n" +
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

  const configPath = join(home, "config.yml");
  const projectsCleared = existsSync(configPath) ? await clearProjectsInConfig(configPath) : 0;
  // The database file, and the WAL sidecars beside it. It comes back empty from
  // the schema on the next start — which also clears the sessions, so everyone
  // signs in again, exactly what a reset should mean.
  const dbRemoved = await removePaths(home, DB_FILES);
  const foldersRemoved = await removePaths(home, OWN_FOLDERS);

  io.out(
    heading("reset") +
      ok(
        `${plural(projectsCleared, "project")} cleared, the database and ` +
          `${plural(foldersRemoved.length, "data folder")} wiped.\n`,
      ) +
      (dbRemoved.includes("laneyard.db")
        ? dim("  laneyard.db is gone; it comes back empty on the next start.\n")
        : dim("  There was no database to remove.\n")) +
      "\n" +
      warn("Kept: your accounts, and the vault key at " + (inv.key?.path ?? join(home, "key")) + ".\n") +
      dim("  You sign in with the same names, and older database backups stay readable.\n") +
      dim("  The git remotes and your credential originals were never Laneyard's to touch.\n"),
  );
  return 0;
}

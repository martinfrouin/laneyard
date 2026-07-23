import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ConfigStore } from "../config/store.js";
import { CredentialStore } from "../db/credentials.js";
import { openDatabase } from "../db/open.js";
import { RunStore } from "../db/runs.js";
import { SecretStore } from "../db/secrets.js";
import { removeProjectData } from "../data/remove-project.js";
import { LogStore } from "../logs/store.js";
import { Vault } from "../secrets/vault.js";
import type { CommandIo } from "./home.js";
import { readLine } from "./home.js";
import { bad, bold, dim, field, heading, ok, warn } from "./style.js";

export const REMOVE_USAGE = `laneyard remove <slug> [--dry-run]

Removes everything Laneyard holds for one project: its block in config.yml, its
clone, its artifacts, its run history and logs, and its own secrets and signing
blocks in the vault. It does not touch the git remote, the credential originals,
or the global secrets and signing blocks other projects share.

  laneyard remove <slug> --dry-run   show what would go and stop

The run history is the one thing here nothing can rebuild, so it is confirmed by
typing the project's slug back, not \`y\`.
`;

const plural = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`;

/**
 * What one project holds, read before anything is touched.
 *
 * Read through a read-only handle, with the courtesy `uninstall` uses: SQLite
 * makes a `-shm` beside a WAL database even to read it, so one that was not
 * there is removed again afterwards. `--dry-run` promises not to write, and this
 * is what keeps the promise. A missing database is not an error — a project can
 * be declared before the server ever ran — it just means nothing has run and
 * nothing is stored.
 */
interface Counts {
  activeRun: boolean;
  runs: number;
  secrets: number;
  signingBlocks: number;
}

async function readCounts(home: string, slug: string): Promise<Counts> {
  const dbPath = join(home, "laneyard.db");
  if (!existsSync(dbPath)) return { activeRun: false, runs: 0, secrets: 0, signingBlocks: 0 };

  const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];
  const ours = await Promise.all(
    sidecars.map(async (path) => ((await stat(path).catch(() => null)) === null ? path : null)),
  );

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const runs = new RunStore(db);
    return {
      activeRun: runs.hasActiveRun(slug),
      runs: runs.listByProject(slug, -1).length,
      secrets: new SecretStore(db).listOwn(slug).length,
      signingBlocks: new CredentialStore(db).listOwn(slug).length,
    };
  } finally {
    db?.close();
    for (const path of ours) {
      if (path !== null) await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

/** The inventory, and what the removal will and will not reach. */
function renderInventory(slug: string, name: string, home: string, counts: Counts, clonePath: string): string {
  const cloned = existsSync(clonePath);
  return (
    heading(`laneyard remove "${slug}"`) +
    field("home", home) + "\n" +
    field("project", name === slug ? slug : `${name} (${slug})`) + "\n" +
    heading("what will be removed") +
    field("runs", counts.runs === 0 ? dim("no run yet") : plural(counts.runs, "run")) + "\n" +
    field("clone", cloned ? clonePath : dim("not cloned")) + "\n" +
    field("secrets", plural(counts.secrets, "project secret")) + "\n" +
    field("signing", plural(counts.signingBlocks, "project signing block")) + "\n" +
    heading("what will not be touched") +
    dim("  the git remote — the repository is yours, on your host and your disk.\n") +
    dim("  the credential originals — Laneyard removes only its own encrypted copy;\n") +
    dim("  the .p8 and the keystore you uploaded are wherever you keep them.\n") +
    dim("  global secrets and global signing blocks — shared by every project.\n")
  );
}

/**
 * Entry point for `laneyard remove <slug>`.
 *
 * The command-line equivalent of removing a project from the interface. It reads
 * the inventory first, prints what will and will not go, and only then asks for
 * the slug typed back — the same gate the web route uses, for the same reason:
 * the run history it deletes is the one thing here nothing can rebuild.
 */
export async function runRemoveCommand(home: string, args: string[], io: CommandIo): Promise<number> {
  let dryRun = false;
  let slug: string | null = null;
  for (const arg of args) {
    if (arg === "--dry-run" || arg === "-n") dryRun = true;
    else if (arg.startsWith("-")) {
      io.err(`Unknown option: ${arg}\n\n${REMOVE_USAGE}`);
      return 1;
    } else if (slug === null) slug = arg;
    else {
      io.err(`One project at a time. Give a single slug.\n\n${REMOVE_USAGE}`);
      return 1;
    }
  }

  if (slug === null) {
    io.err(`Which project? Give its slug.\n\n${REMOVE_USAGE}`);
    return 1;
  }

  const configPath = join(home, "config.yml");
  const config = new ConfigStore(configPath);
  const loaded = await config.load();
  if (!loaded.ok) {
    io.err(`Unreadable configuration in ${configPath}: ${loaded.error}\n`);
    return 1;
  }

  const entry = config.project(slug);
  if (!entry) {
    const known = config.projects().map((p) => p.slug);
    io.err(
      `${bad(`Unknown project: "${slug}".`)} ` +
        (known.length > 0 ? `Known projects: ${known.join(", ")}.` : "No project is declared yet.") +
        "\n",
    );
    return 1;
  }

  const clonePath = join(home, "workspaces", slug);
  const counts = await readCounts(home, slug);

  // A run that has begun is reading the workspace this project points at.
  // Refused for the same reason the interface refuses it, and with the same way
  // out: wait for it, or cancel it, then remove the project.
  if (counts.activeRun) {
    io.err(
      "\n" +
        bad(`"${slug}" has a run in flight.`) +
        " Wait for it to finish, or cancel it, then remove the project. Nothing was removed.\n",
    );
    return 1;
  }

  io.out(renderInventory(slug, entry.name, home, counts, clonePath));

  if (dryRun) {
    io.out(
      "\n" +
        dim(`Nothing was removed. Run \`laneyard remove ${slug}\` without --dry-run to remove it.`) +
        "\n",
    );
    return 0;
  }

  // Typed in full, not `y`: this deletes a run history nothing can rebuild, and
  // the slug typed back is what proves the person read which project is going.
  io.out(
    "\n" +
      bold("Type the project's slug, exactly, to confirm:") + "\n" +
      `  ${slug}\n` +
      "\n> ",
  );
  const answer = await readLine(io.stdin);
  if (answer !== slug) {
    io.err(
      "\n" +
        bad(
          answer === ""
            ? "Nothing was typed, so nothing was removed."
            : "That is not the slug, so nothing was removed.",
        ) +
        "\n",
    );
    return 1;
  }

  const db = openDatabase(join(home, "laneyard.db"));
  try {
    const result = await removeProjectData(
      {
        configPath,
        reloadConfig: () => config.load(),
        runs: new RunStore(db),
        logs: new LogStore(join(home, "logs")),
        vault: await Vault.open(home, new SecretStore(db), new CredentialStore(db)),
        workspacePath: (s) => join(home, "workspaces", s),
        artifactsDir: (runId) => join(home, "artifacts", String(runId)),
      },
      slug,
    );

    io.out(
      heading("removed") +
        ok(
          `"${slug}": ${plural(result.runs, "run")}, ${plural(result.secrets, "secret")}, ` +
            `${plural(result.signingBlocks, "signing block")}.\n`,
        ) +
        (result.workspace
          ? dim(`  ${result.clonePath} is gone.\n`)
          : dim("  There was no clone to remove.\n")) +
        dim(`  The block is out of ${configPath}.\n`) +
        "\n" +
        warn(
          "The git remote and your credential originals were never Laneyard's to touch, and " +
            "global secrets and signing blocks were left alone.\n",
        ),
    );
    return 0;
  } finally {
    db.close();
  }
}

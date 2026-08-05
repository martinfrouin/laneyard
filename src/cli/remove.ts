import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadRepoConfig } from "../config/load.js";
import { ConfigStore } from "../config/store.js";
import { BuildNumberStore } from "../db/build-numbers.js";
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

export const REMOVE_USAGE = `laneyard remove [<slug>] [--dry-run]

Run from the directory that holds laneyard.yml — the repository root for most
projects, the app's own folder in a monorepo — and the project is the one that
file names. Give a slug instead when there is no such file.

Removes everything Laneyard holds for that project: its block in config.yml, its
clone, its artifacts, its run history and logs, and its own secrets and signing
blocks in the vault. It also removes that laneyard.yml, which you then commit —
one naming another project is left alone. It does not touch the git remote, the
credential originals, or the global secrets and signing blocks other projects
share.

  laneyard remove --dry-run   show what would go and stop

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
      secrets: new SecretStore(db).list(slug).length,
      signingBlocks: new CredentialStore(db).list(slug).length,
    };
  } finally {
    db?.close();
    for (const path of ours) {
      if (path !== null) await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

/** The inventory, and what the removal will and will not reach. */
function renderInventory(
  slug: string,
  name: string,
  home: string,
  counts: Counts,
  clonePath: string,
  ymlPath: string | null,
): string {
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
    // The one thing removed outside `home`: the repository's own file.
    (ymlPath === null ? "" : field("laneyard.yml", ymlPath) + "\n") +
    heading("what will not be touched") +
    dim("  the git remote — the repository is yours, on your host and your disk.\n") +
    dim("  the credential originals — Laneyard removes only its own encrypted copy;\n") +
    dim("  the .p8 and the keystore you uploaded are wherever you keep them.\n") +
    dim("  global secrets and global signing blocks — shared by every project.\n")
  );
}

/**
 * Entry point for `laneyard remove`, run from wherever the project's
 * `laneyard.yml` sits — the repository root unless the app is one folder of a
 * monorepo.
 *
 * The project is the one whose `laneyard.yml` sits in `cwd`, so the command names
 * what the directory already is. A slug given outright overrides that, and is the
 * only way to reach a project whose file was never written, lost its slug, or
 * whose repository is no longer on this machine.
 *
 * It reads the inventory first, prints what will and will not go, and only then
 * asks for the slug typed back — the same gate the web route uses, for the same
 * reason: the run history it deletes is the one thing here nothing can rebuild.
 */
export async function runRemoveCommand(
  home: string,
  cwd: string,
  args: string[],
  io: CommandIo,
): Promise<number> {
  let dryRun = false;
  let given: string | null = null;
  for (const arg of args) {
    if (arg === "--dry-run" || arg === "-n") dryRun = true;
    else if (arg.startsWith("-")) {
      io.err(`Unknown option: ${arg}\n\n${REMOVE_USAGE}`);
      return 1;
    } else if (given === null) given = arg;
    else {
      io.err(`One project at a time. Give a single slug.\n\n${REMOVE_USAGE}`);
      return 1;
    }
  }

  // The project is normally the one whose `laneyard.yml` is here — the file setup
  // wrote, and the slug it recorded in it.
  const ymlPath = join(cwd, "laneyard.yml");
  const inFile = existsSync(ymlPath)
    ? await loadRepoConfig(ymlPath).then((r) => (r.ok ? r.config.slug : undefined))
    : undefined;

  // A slug given outright is the way out when there is no such file: one that
  // was never written, lost its slug, or whose repository is not on this machine
  // any more. Without it those projects could only be removed from the web.
  const slug = given ?? inFile;
  if (slug === undefined || slug === "") {
    io.err(
      "\n" +
        bad(existsSync(ymlPath) ? "This laneyard.yml has no slug." : "No laneyard.yml here.") +
        " Run `laneyard remove` from the directory that holds it — usually the repository" +
        " root — or name the project: `laneyard remove <slug>`.\n",
    );
    return 1;
  }

  // Removed only when it is this project's file. Given a slug explicitly, a
  // `laneyard.yml` naming a different project is somebody else's and stays.
  const ownYml = inFile !== undefined && inFile === slug ? ymlPath : null;

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

  io.out(renderInventory(slug, entry.name, home, counts, clonePath, ownYml));

  if (dryRun) {
    io.out(
      "\n" +
        dim("Nothing was removed. Run `laneyard remove` without --dry-run to remove it.") +
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
        buildNumbers: new BuildNumberStore(db),
        logs: new LogStore(join(home, "logs")),
        vault: await Vault.open(home, new SecretStore(db), new CredentialStore(db)),
        workspacePath: (s) => join(home, "workspaces", s),
        artifactsDir: (runId) => join(home, "artifacts", String(runId)),
      },
      slug,
    );

    // The machine data went first, so a file removed here is one whose project
    // is already gone — never the other way round. `force` because the removal
    // must still report success if the file was deleted by hand meanwhile.
    if (ownYml !== null) await rm(ownYml, { force: true }).catch(() => {});

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
        (ownYml === null ? "" : dim(`  ${ownYml} is gone.\n`)) +
        "\n" +
        // The file is committed, so deleting the working copy is not the end of
        // it — the same trap adoption's report names about a patched Fastfile.
        warn("Commit its removal, or a clone still carries the laneyard.yml.\n") +
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

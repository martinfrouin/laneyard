import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { removeProjectFromConfig } from "../cli/setup.js";
import type { RunStore } from "../db/runs.js";
import type { LogStore } from "../logs/store.js";
import type { Vault } from "../secrets/vault.js";

/**
 * The primitives removing one project needs, and nothing more.
 *
 * A small bag of parts rather than the whole `AppContext`, on purpose: the web
 * route builds it from a running server, and the CLI builds the very same parts
 * straight from a data folder with no server behind them. What the removal does
 * must not depend on which of the two called it.
 */
export interface RemoveProjectDeps {
  /** config.yml, so the project's block can be taken out of it. */
  configPath: string;
  /**
   * Re-reads the configuration after the block is gone. The server watches the
   * file but on a debounce; the CLI has nothing watching at all — so both hand
   * in the reload that makes the very next read truthful.
   */
  reloadConfig: () => Promise<unknown>;
  runs: RunStore;
  logs: LogStore;
  vault: Vault;
  workspacePath: (slug: string) => string;
  artifactsDir: (runId: number) => string;
}

/** What the removal did: the counts, and the clone it deleted. */
export interface RemovedProject {
  /** False when no block carried that slug — the caller answers 404, or refuses. */
  found: boolean;
  runs: number;
  artifacts: number;
  workspace: boolean;
  clonePath: string;
  secrets: number;
  signingBlocks: number;
}

/**
 * Removes everything Laneyard holds for one project, and reports what went.
 *
 * The block leaves config.yml, through the YAML document so the rest of a
 * hand-written file is untouched; the clone is deleted; every artifact folder
 * goes; the run history — the rows and their logs — is deleted; and the
 * project's own secrets and signing blocks are forgotten from the vault. The
 * history is the one thing here that cannot be made again.
 *
 * What it does not reach, and why each is out of scope:
 *
 *  - the git remote. The repository is on the host and the user's disk. It is
 *    theirs, not Laneyard's, and nothing here reads or writes it.
 *  - the credential originals. Laneyard removes its own encrypted copy of a
 *    `.p8` or a keystore; the file that went in is still in the password manager
 *    or the safe it came from.
 *  - global secrets and global signing blocks. They are read by every project on
 *    the machine — `vault.forget` touches only slug-scoped rows.
 *
 * It removes; it does not confirm and it does not shape a reply. The callers do
 * that: the route behind a slug typed back, the CLI behind the same. The one
 * irreversible thing must not be reachable without one of them.
 */
export async function removeProjectData(deps: RemoveProjectDeps, slug: string): Promise<RemovedProject> {
  const clonePath = deps.workspacePath(slug);

  // Read before anything is touched. -1 is SQLite's "no limit": every run of the
  // project, because each one names an artifact folder and a log file to remove.
  const runs = deps.runs.listByProject(slug, -1);

  // The config block first: once it is gone the project cannot be started, so
  // nothing new begins reading the files the rest of this is about to remove.
  const removed = await removeProjectFromConfig(deps.configPath, slug);
  if (!removed) {
    return { found: false, runs: 0, artifacts: 0, workspace: false, clonePath, secrets: 0, signingBlocks: 0 };
  }
  await deps.reloadConfig();

  // The clone.
  const workspace = existsSync(clonePath);
  await rm(clonePath, { recursive: true, force: true });

  // The artifacts and the logs, one of each per run that produced them.
  let artifacts = 0;
  for (const run of runs) {
    const dir = deps.artifactsDir(run.id);
    if (existsSync(dir)) artifacts += 1;
    await rm(dir, { recursive: true, force: true });
    await deps.logs.remove(run.id);
  }

  // The run history: the rows, and their steps and artifact records by cascade.
  deps.runs.removeByProject(slug);

  // The project's own secrets and signing blocks. Slug-scoped only: a global
  // secret three other projects read is not this one's to take.
  const forgotten = deps.vault.forget(slug);

  return {
    found: true,
    runs: runs.length,
    artifacts,
    workspace,
    clonePath,
    secrets: forgotten.secrets,
    signingBlocks: forgotten.credentials,
  };
}

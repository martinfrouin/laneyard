import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectSettings } from "../config/schema.js";
import type { RunStore, Step } from "../db/runs.js";
import { gitEnvFor, Workspace } from "../git/workspace.js";
import type { GitAuth } from "../git/workspace.js";
import type { LogStore } from "../logs/store.js";
import { summarizeFailure } from "../heuristics/error-summary.js";
import { appRootOf, searchDir } from "../heuristics/platforms.js";
import { Redactor, scrub } from "../logs/redact.js";
import { assertFastlaneDir } from "../sidecar/fastlane-dir.js";
import { collectArtifacts } from "./artifacts.js";
import {
  removeGradleProperties,
  sweepGradleProperties,
  writeGradleProperties,
} from "./gradle-properties.js";
import type { KeystoreBlock } from "./gradle-properties.js";
import { removeEnvFile, sweepEnvFile, writeEnvFile } from "./env-file.js";
import { LiveStepTracker } from "./live-steps.js";
import { startPty } from "./pty.js";
import { readReport } from "./report.js";

export interface ExecuteRunOptions {
  runId: number;
  runs: RunStore;
  logs: LogStore;
  workspacePath: string;
  artifactsDir: string;
  gitUrl: string;
  gitAuth?: GitAuth;
  branch: string;
  /**
   * Resolves the effective settings. Called **after** the workspace is
   * prepared, because the laneyard.yml it reads lives in the repository:
   * on the first run, it doesn't exist on disk yet when the run is created.
   */
  resolveSettings: () => Promise<ProjectSettings>;
  env: NodeJS.ProcessEnv;
  /** Resolved secrets, added to the run's environment. */
  secrets?: Record<string, string>;
  /**
   * Variables pointing at the signing blocks already written to disk for this
   * run — see `materialise.ts`. Passed in rather than derived here for the same
   * reason `secrets` is: this function is handed plaintext, never the vault.
   */
  credentialEnv?: Record<string, string>;
  /**
   * The keystore materialised for this run, when one applies.
   *
   * Only reason it is here and not folded into `credentialEnv`: gradle may read
   * a properties file rather than the environment, and the file has to be
   * written into the clone — which does not exist until this function has
   * prepared it. See `gradle-properties.ts` for why that is worth doing at all.
   */
  androidKeystore?: KeystoreBlock;
  /**
   * The variables that also go into the environment file, in the clear.
   *
   * A subset of `secrets`, never a replacement for it: the tick decides
   * membership of the file, and a ticked variable still reaches the run through
   * the environment like every other one. Here for the same reason
   * `androidKeystore` is — the file goes into a clone that does not exist until
   * this function has prepared it.
   */
  envFileValues?: Record<string, string>;
  /**
   * Removes whatever was written for this run, called on every way out.
   * Its owner is the caller, but its timing is not: only this function knows
   * when the child process has stopped reading those files.
   */
  cleanup?: () => Promise<void>;
  /** The values that must not appear in the log or in the browser. */
  maskedValues?: string[];
  /** Called for each output fragment, with its position in the log. */
  onChunk: (chunk: string, offset: number) => void;
  /** Aborting stops the run: the pseudo-terminal is signalled, as on timeout. */
  signal?: AbortSignal;
}

export interface ExecuteRunResult {
  status: "success" | "failed" | "cancelled";
}


/**
 * Runs a complete run through and sets its state transitions.
 *
 * Never throws: every error is converted into a documented `failed` run,
 * because a run that disappears without a trace is the worst possible
 * behaviour for a build server.
 *
 * The whole of it is wrapped so the signing blocks written for this run are
 * removed on every way out — the successful return, the four early exits, the
 * cancellations, and the exception this function promises not to raise but
 * cannot rule out. A private key left on disk because a clone failed is a leak
 * with no expiry date, and the only moment at which it is certainly safe to
 * delete is the moment fastlane has stopped running.
 *
 * The gradle properties file is removed here too, and it is the one written
 * somewhere this run does not own: the clone is kept between runs, so passwords
 * left in it would sit in a working tree until someone noticed. The path is
 * carried out through a holder rather than returned, because it is decided deep
 * inside the run and has to be visible to a `finally` wrapped around all of it.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<ExecuteRunResult> {
  const wrote: Written = { properties: null, envFile: null };
  try {
    return await execute(opts, wrote);
  } finally {
    // Guarded by the marker, so a file the user replaced mid-run survives.
    await removeGradleProperties(wrote.properties).catch(() => {});
    await removeEnvFile(wrote.envFile).catch(() => {});
    // Deliberately swallowed: by now the log writer is closed and the run's
    // verdict is recorded, so there is nowhere left to report this without
    // rewriting a finished run's outcome as a failure it did not have. A
    // directory that resists `rm -rf` is a broken disk, not a broken build.
    if (opts.cleanup) await opts.cleanup().catch(() => {});
  }
}

/**
 * The files this run wrote into the clone, carried out to the `finally`.
 *
 * Both are written somewhere the run does not own — the clone is kept between
 * runs — and both are decided deep inside `execute`, so a holder is how their
 * paths reach the cleanup wrapped around all of it.
 */
interface Written {
  properties: string | null;
  envFile: string | null;
}

async function execute(opts: ExecuteRunOptions, wrote: Written): Promise<ExecuteRunResult> {
  const { runId, runs, logs } = opts;
  const writer = await logs.open(runId);
  const tracker = new LiveStepTracker();
  const redactor = new Redactor(opts.maskedValues ?? []);

  // Redaction happens here and nowhere else: this is the single point through
  // which every byte of output passes on its way to the file, the step tracker
  // and the browser. Filtering further downstream would mean filtering three
  // times, and forgetting one of them eventually.
  const emit = async (text: string): Promise<void> => {
    const safe = redactor.push(text);
    if (safe === "") return;
    const offset = await writer.append(safe);
    tracker.consume(safe, offset);
    opts.onChunk(safe, offset);
  };

  const emitRest = async (): Promise<void> => {
    const rest = redactor.flush();
    if (rest === "") return;
    const offset = await writer.append(rest);
    tracker.consume(rest, offset);
    opts.onChunk(rest, offset);
  };

  // The error summary is stored in the database and rendered in the interface
  // without passing through the stream above, so it needs its own, one-shot pass.
  const hide = (text: string): string => scrub(text, opts.maskedValues ?? []);

  // Shared by every early exit, so flushing and closing the log writer cannot
  // drift between the failure path and the two cancellation checkpoints below.
  const finishAs = async (
    status: "failed" | "cancelled",
    message: string,
  ): Promise<ExecuteRunResult> => {
    await emit(`\n${message}\n`);
    await emitRest();
    await writer.close();
    runs.finish(runId, { status, exitCode: null, errorSummary: hide(message) });
    return { status };
  };

  const fail = (message: string): Promise<ExecuteRunResult> => finishAs("failed", message);

  // --- Preparation --------------------------------------------------------
  runs.setStatus(runId, "preparing");

  // Cancelled before it even started: no point cloning or fetching a
  // workspace nobody wants built anymore.
  if (opts.signal?.aborted) {
    return finishAs("cancelled", "Cancelled");
  }

  const workspace = new Workspace(opts.workspacePath, opts.gitUrl, opts.gitAuth);

  let commitSha: string;
  try {
    commitSha = await workspace.prepare(opts.branch, (line) => void emit(`${line}\n`));
  } catch (cause) {
    return fail(`Could not prepare the workspace: ${(cause as Error).message}`);
  }

  runs.markRunning(runId, { branch: opts.branch, commitSha });

  // The workspace finally exists: only now is the repository's laneyard.yml
  // readable, so only now are the settings known. The resolution is guarded:
  // the project may have disappeared from config.yml during preparation,
  // and a run must never evaporate on an exception.
  let settings: ProjectSettings;
  try {
    settings = await opts.resolveSettings();
  } catch (cause) {
    return fail(`Unreadable project settings: ${(cause as Error).message}`);
  }

  // The properties file gradle may be waiting for, in the clone rather than in
  // this run's own directory — `gradle-properties.ts` says why, and why it is
  // hedged about with a marker. It happens here, after the settings, because
  // the app root it is written under is derived from `fastlane_dir`, and before
  // the cancellation checkpoint, so that a run cancelled in this exact instant
  // still leaves the workspace as it found it.
  //
  // The sweep first, and whether or not this project still has a keystore: a
  // run killed mid-build leaves a file nothing was left running to remove, and
  // the next run is the first moment anything can. Its failure is not reported
  // — a leftover that resists removal is a broken disk, not a broken build, and
  // saying so here would fail a run for a file it has not needed yet.
  //
  // The app's own directory, which is the parent of the configured fastlane
  // folder: the repository root for a plain app, `app/` for one in a monorepo.
  // It is where the properties file goes and, below, where fastlane is started.
  const appRoot = searchDir(opts.workspacePath, appRootOf(settings.fastlane_dir));

  // Before any of that, and before fastlane: a clone without the folder is the
  // one failure fastlane reports worst. It asks whether to set a project up,
  // finds nobody to answer, and prints a Ruby backtrace and a list of GitHub
  // issues over the sentence that mattered. This says it in one line instead.
  try {
    await assertFastlaneDir(opts.workspacePath, settings.fastlane_dir);
  } catch (cause) {
    return fail((cause as Error).message);
  }

  await sweepGradleProperties(appRoot, opts.androidKeystore).catch(() => {});
  await sweepEnvFile(appRoot, settings.env_file).catch(() => {});
  try {
    wrote.properties = await writeGradleProperties(appRoot, opts.androidKeystore);
  } catch (cause) {
    // Failing the run rather than carrying on. Carrying on is what produces the
    // artifact this whole module exists to prevent: a release build that
    // succeeds, signed with the debug key, rejected by the store days later.
    return fail(`Could not write the signing properties file: ${(cause as Error).message}`);
  }

  try {
    wrote.envFile = await writeEnvFile(appRoot, settings.env_file, opts.envFileValues ?? {});
  } catch (cause) {
    // Failing for the same reason, and it is the same shape of failure. A build
    // that carries on without the file it was configured to read does not stop:
    // it produces an app pointed at nothing, which is discovered by a person
    // opening it rather than by this run.
    return fail(`Could not write the environment file: ${(cause as Error).message}`);
  }

  // Cancelled during preparation: fastlane never gets to start.
  if (opts.signal?.aborted) {
    return finishAs("cancelled", "Cancelled");
  }

  // --- Execution -----------------------------------------------------------
  const useBundle = settings.runtime === "bundle";
  const reportPath = join(opts.workspacePath, settings.fastlane_dir, "report.xml");

  // A report may still be lying around, left by a previous run that fastlane
  // didn't have time to overwrite. Without this cleanup, a run that fails
  // before even reaching fastlane would adopt the previous run's timeline.
  await rm(reportPath, { force: true });

  // The identity fallback is only set when the workspace has none of its own:
  // a clone Laneyard made carries no `user.email`, so a lane running `git
  // commit` fails with "Please tell me who you are" on any server whose global
  // git configuration is empty. Where an identity does exist — the server's own,
  // or one set on the repository — it is left to win, because these variables
  // override configuration rather than backing it up.
  const gitEnv: NodeJS.ProcessEnv = gitEnvFor(opts.gitAuth ?? { kind: "none" });
  if ((await workspace.identity().catch(() => null)) === null) {
    gitEnv["GIT_AUTHOR_NAME"] = "Laneyard";
    gitEnv["GIT_AUTHOR_EMAIL"] = "laneyard@localhost";
    gitEnv["GIT_COMMITTER_NAME"] = "Laneyard";
    gitEnv["GIT_COMMITTER_EMAIL"] = "laneyard@localhost";
  }

  const { done } = startPty({
    command: useBundle ? "bundle" : "fastlane",
    args: useBundle
      ? ["exec", "fastlane", ...laneArgs(opts)]
      : laneArgs(opts),
    // The app's directory, not the repository root. fastlane looks for
    // `fastlane/` in the directory it was started from and nowhere else — no
    // walking up, no looking down — so a project whose Fastfile sits in
    // `app/fastlane` has to be started from `app`. Started from the root it
    // finds nothing and offers to set fastlane up, which on a build server
    // means a crash: there is nobody there to answer the question.
    cwd: appRoot,
    env: {
      ...opts.env,
      ...(opts.secrets ?? {}),
      // After the secrets: a block is the more deliberate of the two, and it is
      // the only one whose path variable points at a file that actually exists
      // right now. A stray secret of the same name would otherwise send gradle
      // looking for a keystore at a path from a previous machine.
      ...(opts.credentialEnv ?? {}),
      // Order matters: secrets come after opts.env so a stored secret wins over
      // a variable that happens to exist in the server's own environment, and
      // before these fixed variables so no secret can override CI.
      CI: "true",
      FASTLANE_SKIP_UPDATE_CHECK: "1",
      FORCE_COLOR: "1",
      // A lane may run git itself — bumping and pushing a build number is a
      // reasonable thing for a Fastfile to do — and until now that `sh("git
      // push")` inherited none of the care Laneyard takes with its own git
      // calls. It got the worst failure available: a push needing a credential
      // did not fail, it waited, and the run sat there until its timeout with
      // nothing in the log to say what for.
      //
      // After the secrets, deliberately. These are not preferences: a stored
      // `GIT_TERMINAL_PROMPT=1` would restore exactly the hang this removes.
      ...gitEnv,
    },
    onData: (chunk) => void emit(chunk),
    timeoutMs: settings.timeout_minutes * 60_000,
    signal: opts.signal,
  });

  const outcome = await done;
  await emitRest();

  // The moment gradle has certainly stopped reading it, which is earlier than
  // the `finally` and worth taking: the artifact collection below globs the
  // workspace, and a project whose globs are broad enough would otherwise be
  // offered its own signing passwords as a downloadable artifact. The `finally`
  // still runs — this is a narrowing, not a replacement, and removing a file
  // that is already gone costs nothing.
  await removeGradleProperties(wrote.properties).catch(() => {});

  // --- Timeline -------------------------------------------------------------
  // Everything that follows is after-sales service: the timeline and the
  // artifacts embellish a run that's already finished. A database that
  // refuses an insert or a file that evaporates must not cost the run's
  // verdict, nor let an exception bubble up to the server, which has no one
  // to catch it.
  try {
    await recordOutcome();
  } catch (cause) {
    await emit(`\nIncomplete timeline or artifacts: ${(cause as Error).message}\n`);
    await emitRest();
  }

  await writer.close();

  if (outcome.exitCode === 0 && !outcome.timedOut) {
    runs.finish(runId, { status: "success", exitCode: 0, errorSummary: null });
    return { status: "success" };
  }

  if (opts.signal?.aborted) {
    // Checked ahead of the failure case: the SIGINT/SIGKILL escalation leaves
    // fastlane with a nonzero exit code, which would otherwise read as a crash
    // rather than the cancellation it actually was.
    runs.finish(runId, {
      status: "cancelled",
      exitCode: outcome.exitCode,
      errorSummary: "Cancelled",
    });
    return { status: "cancelled" };
  }

  const summary = outcome.timedOut
    ? hide(`Run interrupted after ${settings.timeout_minutes} minutes`)
    : hide(summarizeFailure(await logs.read(runId), outcome.exitCode));

  runs.finish(runId, { status: "failed", exitCode: outcome.exitCode, errorSummary: summary });
  return { status: "failed" };

  async function recordOutcome(): Promise<void> {
    const report = await readReport(reportPath);
    const live = tracker.steps();

    if (report) {
      // The report is authoritative; live spotting only contributes the offsets.
      const steps: Step[] = report.map((s, i) => ({
        idx: s.idx,
        name: s.name,
        durationMs: s.durationMs,
        status: s.status,
        logOffset: live[i]?.logOffset ?? null,
        source: "report",
      }));
      runs.replaceSteps(runId, steps);
      await rm(reportPath, { force: true });
    } else if (live.length > 0) {
      // Cancelled, timed out, or interrupted run: we keep what was seen, flagging it.
      runs.replaceSteps(
        runId,
        live.map((s, i) => ({
          idx: i,
          name: s.name,
          durationMs: null,
          status: "unknown",
          logOffset: s.logOffset,
          source: "live" as const,
        })),
      );
    }

    // --- Artifacts ----------------------------------------------------------
    const collected = await collectArtifacts(
      opts.workspacePath,
      settings.artifact_globs,
      opts.artifactsDir,
    );
    for (const a of collected) runs.addArtifact(runId, a);
  }
}

function laneArgs(opts: ExecuteRunOptions): string[] {
  const run = opts.runs.get(opts.runId);
  if (!run) return [];
  const args = run.platform ? [run.platform, run.lane] : [run.lane];
  for (const [key, value] of Object.entries(run.params)) args.push(`${key}:${value}`);
  return args;
}

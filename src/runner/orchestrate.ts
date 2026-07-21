import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectSettings } from "../config/schema.js";
import type { RunStore, Step } from "../db/runs.js";
import { Workspace } from "../git/workspace.js";
import type { GitAuth } from "../git/workspace.js";
import type { LogStore } from "../logs/store.js";
import { summarizeFailure } from "../heuristics/error-summary.js";
import { Redactor, scrub } from "../logs/redact.js";
import { collectArtifacts } from "./artifacts.js";
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
  /** The values that must not appear in the log or in the browser. */
  maskedValues?: string[];
  /** Called for each output fragment, with its position in the log. */
  onChunk: (chunk: string, offset: number) => void;
}

export interface ExecuteRunResult {
  status: "success" | "failed";
}


/**
 * Runs a complete run through and sets its state transitions.
 *
 * Never throws: every error is converted into a documented `failed` run,
 * because a run that disappears without a trace is the worst possible
 * behaviour for a build server.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<ExecuteRunResult> {
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

  const fail = async (message: string): Promise<ExecuteRunResult> => {
    await emit(`\n${message}\n`);
    await emitRest();
    await writer.close();
    runs.finish(runId, { status: "failed", exitCode: null, errorSummary: hide(message) });
    return { status: "failed" };
  };

  // --- Preparation --------------------------------------------------------
  runs.setStatus(runId, "preparing");
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

  // --- Execution -----------------------------------------------------------
  const useBundle = settings.runtime === "bundle";
  const reportPath = join(opts.workspacePath, settings.fastlane_dir, "report.xml");

  // A report may still be lying around, left by a previous run that fastlane
  // didn't have time to overwrite. Without this cleanup, a run that fails
  // before even reaching fastlane would adopt the previous run's timeline.
  await rm(reportPath, { force: true });

  const { done } = startPty({
    command: useBundle ? "bundle" : "fastlane",
    args: useBundle
      ? ["exec", "fastlane", ...laneArgs(opts)]
      : laneArgs(opts),
    cwd: opts.workspacePath,
    env: {
      ...opts.env,
      ...(opts.secrets ?? {}),
      // Order matters: secrets come after opts.env so a stored secret wins over
      // a variable that happens to exist in the server's own environment, and
      // before these three fixed variables so no secret can override CI.
      CI: "true",
      FASTLANE_SKIP_UPDATE_CHECK: "1",
      FORCE_COLOR: "1",
    },
    onData: (chunk) => void emit(chunk),
    timeoutMs: settings.timeout_minutes * 60_000,
  });

  const outcome = await done;
  await emitRest();

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

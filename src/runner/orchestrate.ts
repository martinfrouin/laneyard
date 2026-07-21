import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectSettings } from "../config/schema.js";
import type { RunStore, Step } from "../db/runs.js";
import { Workspace } from "../git/workspace.js";
import type { GitAuth } from "../git/workspace.js";
import type { LogStore } from "../logs/store.js";
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
   * Résout les réglages effectifs. Appelée **après** la préparation du workspace,
   * parce que le laneyard.yml qu'elle lit vit dans le dépôt : au premier run,
   * il n'existe pas encore sur disque au moment où le run est créé.
   */
  resolveSettings: () => Promise<ProjectSettings>;
  env: NodeJS.ProcessEnv;
  /** Appelé pour chaque fragment de sortie, avec sa position dans le log. */
  onChunk: (chunk: string, offset: number) => void;
}

export interface ExecuteRunResult {
  status: "success" | "failed";
}

/** Extrait de quoi afficher une cause d'échec sans ouvrir le log intégral. */
function summarizeFailure(log: string, exitCode: number): string {
  const lines = log
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const flagged = [...lines].reverse().find((l) => /error|failed|failure/i.test(l));
  return flagged ? flagged.slice(0, 500) : `fastlane s'est arrêté avec le code ${exitCode}`;
}

/**
 * Enchaîne un run complet et pose ses transitions d'état.
 *
 * Ne lève jamais : toute erreur est convertie en run `failed` documenté, parce
 * qu'un run qui disparaît sans laisser de trace est le pire des comportements
 * pour un serveur de build.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<ExecuteRunResult> {
  const { runId, runs, logs } = opts;
  const writer = await logs.open(runId);
  const tracker = new LiveStepTracker();

  const emit = async (text: string): Promise<void> => {
    const offset = await writer.append(text);
    tracker.consume(text, offset);
    opts.onChunk(text, offset);
  };

  const fail = async (message: string): Promise<ExecuteRunResult> => {
    await emit(`\n${message}\n`);
    await writer.close();
    runs.finish(runId, { status: "failed", exitCode: null, errorSummary: message });
    return { status: "failed" };
  };

  // --- Préparation -------------------------------------------------------
  runs.setStatus(runId, "preparing");
  const workspace = new Workspace(opts.workspacePath, opts.gitUrl, opts.gitAuth);

  let commitSha: string;
  try {
    commitSha = await workspace.prepare(opts.branch, (line) => void emit(`${line}\n`));
  } catch (cause) {
    return fail(`Préparation du workspace impossible : ${(cause as Error).message}`);
  }

  runs.markRunning(runId, { branch: opts.branch, commitSha });

  // Le workspace existe enfin : c'est seulement maintenant que le laneyard.yml
  // du dépôt est lisible, donc seulement maintenant que les réglages sont connus.
  // La résolution est protégée : le projet peut avoir disparu de config.yml
  // pendant la préparation, et un run ne doit jamais s'évaporer sur une exception.
  let settings: ProjectSettings;
  try {
    settings = await opts.resolveSettings();
  } catch (cause) {
    return fail(`Réglages du projet illisibles : ${(cause as Error).message}`);
  }

  // --- Exécution ---------------------------------------------------------
  const useBundle = settings.runtime === "bundle";
  const reportPath = join(opts.workspacePath, settings.fastlane_dir, "report.xml");

  const { done } = startPty({
    command: useBundle ? "bundle" : "fastlane",
    args: useBundle
      ? ["exec", "fastlane", ...laneArgs(opts)]
      : laneArgs(opts),
    cwd: opts.workspacePath,
    env: {
      ...opts.env,
      // Un run non interactif échoue vite au lieu de figer sur un prompt invisible.
      CI: "true",
      FASTLANE_SKIP_UPDATE_CHECK: "1",
      FORCE_COLOR: "1",
    },
    onData: (chunk) => void emit(chunk),
    timeoutMs: settings.timeout_minutes * 60_000,
  });

  const outcome = await done;
  await writer.close();

  // --- Chronologie -------------------------------------------------------
  const report = await readReport(reportPath);
  const live = tracker.steps();

  if (report) {
    // Le rapport fait autorité ; le repérage en direct n'apporte que les décalages.
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
    // Run annulé, expiré ou interrompu : on garde ce qui a été vu, en le signalant.
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

  // --- Artefacts et statut final ----------------------------------------
  const collected = await collectArtifacts(
    opts.workspacePath,
    settings.artifact_globs,
    opts.artifactsDir,
  );
  for (const a of collected) runs.addArtifact(runId, a);

  if (outcome.exitCode === 0 && !outcome.timedOut) {
    runs.finish(runId, { status: "success", exitCode: 0, errorSummary: null });
    return { status: "success" };
  }

  const summary = outcome.timedOut
    ? `Run interrompu après ${settings.timeout_minutes} minutes`
    : summarizeFailure(await logs.read(runId), outcome.exitCode);

  runs.finish(runId, { status: "failed", exitCode: outcome.exitCode, errorSummary: summary });
  return { status: "failed" };
}

function laneArgs(opts: ExecuteRunOptions): string[] {
  const run = opts.runs.get(opts.runId);
  if (!run) return [];
  const args = run.platform ? [run.platform, run.lane] : [run.lane];
  for (const [key, value] of Object.entries(run.params)) args.push(`${key}:${value}`);
  return args;
}

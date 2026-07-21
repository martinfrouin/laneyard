import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";
import { LogStore } from "../../src/logs/store.js";
import { executeRun } from "../../src/runner/orchestrate.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

const SETTINGS = {
  fastlane_dir: "fastlane",
  runtime: "system" as const,
  timeout_minutes: 5,
  interactive_default: false,
  artifact_globs: ["build/**/*.ipa"],
  required_secrets: [],
};

async function harness(scenario: "success" | "failure") {
  const origin = await makeOriginRepo({
    "fastlane/Fastfile": "lane :beta do\nend\n",
    // build/ est ignoré : l'artefact est produit par le faux fastlane pendant le
    // run, comme en vrai. Rien de suivi par git n'est déplacé, le workspace
    // reste donc propre pour le run suivant.
    ".gitignore": "build/\n",
  });
  const root = await tmpDir("laneyard-root-");
  const db = openDatabase(":memory:");
  const runs = new RunStore(db);
  const logs = new LogStore(join(root, "logs"));

  const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

  const result = await executeRun({
    runId,
    runs,
    logs,
    workspacePath: join(root, "workspaces", "p"),
    artifactsDir: join(root, "artifacts", String(runId)),
    gitUrl: origin,
    branch: "main",
    resolveSettings: async () => SETTINGS,
    env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: scenario },
    onChunk: () => {},
  });

  return { runId, runs, logs, result };
}

describe("executeRun", () => {
  it("mène un run au succès de bout en bout", async () => {
    const { runId, runs, logs } = await harness("success");
    const run = runs.get(runId)!;

    expect(run.status).toBe("success");
    expect(run.exitCode).toBe(0);
    expect(run.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(run.startedAt).not.toBeNull();
    expect(await logs.read(runId)).toContain("Step: build_app");
  }, 60_000);

  it("enregistre les étapes du rapport avec le décalage du repérage en direct", async () => {
    const { runId, runs } = await harness("success");
    const steps = runs.steps(runId);

    expect(steps.map((s) => s.name)).toEqual(["match", "build_app"]);
    expect(steps[0]!.source).toBe("report");
    expect(steps[0]!.durationMs).toBe(1500);
    expect(steps[1]!.logOffset).toBeGreaterThan(0);
  }, 60_000);

  it("collecte les artefacts correspondant aux motifs", async () => {
    const { runId, runs } = await harness("success");
    const arts = runs.artifacts(runId);

    expect(arts).toHaveLength(1);
    expect(arts[0]!.filename).toBe("Popotes.ipa");
    expect(arts[0]!.kind).toBe("ipa");
  }, 60_000);

  it("marque l'échec et retient un résumé d'erreur", async () => {
    const { runId, runs } = await harness("failure");
    const run = runs.get(runId)!;

    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(1);
    expect(runs.steps(runId).find((s) => s.name === "build_app")?.status).toBe("failed");
  }, 60_000);

  it("échoue proprement si la résolution des réglages lève", async () => {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    await executeRun({
      runId,
      runs,
      logs,
      workspacePath: join(root, "ws"),
      artifactsDir: join(root, "art"),
      gitUrl: origin,
      branch: "main",
      // Cas réel : le projet a disparu de config.yml pendant la préparation.
      resolveSettings: async () => {
        throw new Error("projet inconnu");
      },
      env: {},
      onChunk: () => {},
    });

    const run = runs.get(runId)!;
    expect(run.status).toBe("failed");
    expect(run.errorSummary).toMatch(/projet inconnu/);
  }, 60_000);

  it("échoue avant le lancement si le dépôt est inaccessible", async () => {
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    await executeRun({
      runId,
      runs,
      logs,
      workspacePath: join(root, "ws"),
      artifactsDir: join(root, "art"),
      gitUrl: "/nexiste/pas/depot.git",
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: {},
      onChunk: () => {},
    });

    const run = runs.get(runId)!;
    expect(run.status).toBe("failed");
    expect(run.errorSummary).toMatch(/git|dépôt|clone/i);
    // Un run qui n'a jamais atteint fastlane n'a aucune étape.
    expect(runs.steps(runId)).toEqual([]);
  }, 60_000);
});

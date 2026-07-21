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
    // build/ is ignored: the artifact is produced by the fake fastlane during
    // the run, just like the real one. Nothing tracked by git is moved, so
    // the workspace stays clean for the next run.
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
  it("carries a run through to success end to end", async () => {
    const { runId, runs, logs } = await harness("success");
    const run = runs.get(runId)!;

    expect(run.status).toBe("success");
    expect(run.exitCode).toBe(0);
    expect(run.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(run.startedAt).not.toBeNull();
    expect(await logs.read(runId)).toContain("Step: build_app");
  }, 60_000);

  it("records the report's steps with the live-spotting offset", async () => {
    const { runId, runs } = await harness("success");
    const steps = runs.steps(runId);

    expect(steps.map((s) => s.name)).toEqual(["match", "build_app"]);
    expect(steps[0]!.source).toBe("report");
    expect(steps[0]!.durationMs).toBe(1500);
    expect(steps[1]!.logOffset).toBeGreaterThan(0);
  }, 60_000);

  it("collects the artifacts matching the patterns", async () => {
    const { runId, runs } = await harness("success");
    const arts = runs.artifacts(runId);

    expect(arts).toHaveLength(1);
    expect(arts[0]!.filename).toBe("Sample.ipa");
    expect(arts[0]!.kind).toBe("ipa");
  }, 60_000);

  it("marks the failure and keeps an error summary", async () => {
    const { runId, runs } = await harness("failure");
    const run = runs.get(runId)!;

    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(1);
    expect(runs.steps(runId).find((s) => s.name === "build_app")?.status).toBe("failed");
  }, 60_000);

  it("fails cleanly if resolving settings throws", async () => {
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
      // Real case: the project disappeared from config.yml during preparation.
      resolveSettings: async () => {
        throw new Error("unknown project");
      },
      env: {},
      onChunk: () => {},
    });

    const run = runs.get(runId)!;
    expect(run.status).toBe("failed");
    expect(run.errorSummary).toMatch(/unknown project/);
  }, 60_000);

  it("fails before launch if the repository is unreachable", async () => {
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
    expect(run.errorSummary).toMatch(/git|repository|clone/i);
    // A run that never reached fastlane has no steps.
    expect(runs.steps(runId)).toEqual([]);
  }, 60_000);

  it("injects secrets into the run and keeps them out of the log", async () => {
    const origin = await makeOriginRepo({
      "fastlane/Fastfile": "lane :beta do\nend\n",
      ".gitignore": "build/\n",
    });
    const root = await tmpDir("laneyard-root-");
    const db = openDatabase(":memory:");
    const runs = new RunStore(db);
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    await executeRun({
      runId,
      runs,
      logs,
      workspacePath: join(root, "workspaces", "p"),
      artifactsDir: join(root, "artifacts", String(runId)),
      gitUrl: origin,
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: {
        PATH: `${FAKE_DIR}:${process.env["PATH"]}`,
        FAKE_FASTLANE_SCENARIO: "success",
        // The fixture echoes this variable, standing in for a lane that prints
        // a credential by accident — which is exactly how they escape in real life.
        FAKE_FASTLANE_ECHO: "MATCH_PASSWORD",
      },
      secrets: { MATCH_PASSWORD: "s3cr3t-value" },
      maskedValues: ["s3cr3t-value"],
      onChunk: () => {},
    });

    const log = await logs.read(runId);
    expect(log).toContain("MATCH_PASSWORD=");
    expect(log).not.toContain("s3cr3t-value");
    expect(log).toContain("••••••");
  }, 60_000);

  it("keeps the secret out of what the browser receives too", async () => {
    // Redaction happens before the fan-out, so the file and the socket cannot
    // disagree — a fix applied to only one of them would be worse than none.
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n", ".gitignore": "build/\n" });
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    const broadcast: string[] = [];
    await executeRun({
      runId, runs, logs,
      workspacePath: join(root, "workspaces", "p"),
      artifactsDir: join(root, "artifacts", String(runId)),
      gitUrl: origin,
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: {
        PATH: `${FAKE_DIR}:${process.env["PATH"]}`,
        FAKE_FASTLANE_SCENARIO: "success",
        FAKE_FASTLANE_ECHO: "MATCH_PASSWORD",
      },
      secrets: { MATCH_PASSWORD: "s3cr3t-value" },
      maskedValues: ["s3cr3t-value"],
      onChunk: (chunk) => broadcast.push(chunk),
    });

    expect(broadcast.join("")).not.toContain("s3cr3t-value");
  }, 60_000);

  it("stops a running build and records it as cancelled", async () => {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n", ".gitignore": "build/\n" });
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    const controller = new AbortController();
    // The `slow` scenario sleeps; abort once output proves it really started.
    const done = executeRun({
      runId, runs, logs,
      workspacePath: join(root, "workspaces", "p"),
      artifactsDir: join(root, "artifacts", String(runId)),
      gitUrl: origin,
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "slow" },
      signal: controller.signal,
      onChunk: (chunk) => {
        if (chunk.includes("Compiling")) controller.abort();
      },
    });

    const result = await done;
    expect(result.status).toBe("cancelled");
    expect(runs.get(runId)?.status).toBe("cancelled");
    // Cancelling is not failing: the summary must not read like a crash.
    expect(runs.get(runId)?.errorSummary).toMatch(/cancel/i);
  }, 60_000);

  it("cancels before fastlane starts without leaving the run behind", async () => {
    // Aborting during preparation must still produce a finished run, not a ghost.
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    const controller = new AbortController();
    controller.abort();

    const result = await executeRun({
      runId,
      runs,
      logs,
      workspacePath: join(root, "ws"),
      artifactsDir: join(root, "art"),
      // Bogus on purpose: if the abort check were missing, this would fail
      // for a git reason instead, which would make the assertion pass for
      // the wrong reason.
      gitUrl: "/nexiste/pas/depot.git",
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: {},
      signal: controller.signal,
      onChunk: () => {},
    });

    expect(result.status).toBe("cancelled");
    expect(runs.get(runId)?.status).toBe("cancelled");
  }, 60_000);
});

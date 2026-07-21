import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInPty } from "../../src/runner/pty.js";
import { tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

describe("runInPty", () => {
  it("streams the output and returns a zero exit code on success", async () => {
    const chunks: string[] = [];
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "success" },
      onData: (c) => chunks.push(c),
    });

    expect(res.exitCode).toBe(0);
    expect(chunks.join("")).toContain("Step: build_app");
  });

  it("reports the exit code of a failure", async () => {
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "failure" },
      onData: () => {},
    });
    expect(res.exitCode).toBe(1);
  });

  it("kills the process past the allotted timeout", async () => {
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "slow" },
      onData: () => {},
      timeoutMs: 1000,
    });
    expect(res.timedOut).toBe(true);
    // Killed by signal: the code must reflect the violent death, not be 0.
    expect(res.exitCode).not.toBe(0);
    expect(res.signal).not.toBeNull();
  }, 20_000);

  it("fails cleanly if the command doesn't exist", async () => {
    const res = await runInPty({
      command: "nonexistent-command-xyz",
      args: [],
      cwd: await tmpDir(),
      env: { PATH: "/does-not-exist" },
      onData: () => {},
    });
    expect(res.exitCode).not.toBe(0);
  });
});

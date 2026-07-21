import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInPty } from "../../src/runner/pty.js";
import { tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

describe("runInPty", () => {
  it("diffuse la sortie et rend un code de sortie nul en cas de succès", async () => {
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

  it("remonte le code de sortie d'un échec", async () => {
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "failure" },
      onData: () => {},
    });
    expect(res.exitCode).toBe(1);
  });

  it("tue le processus au-delà du délai imparti", async () => {
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "slow" },
      onData: () => {},
      timeoutMs: 1000,
    });
    expect(res.timedOut).toBe(true);
    // Tué par signal : le code doit refléter la mort violente, pas valoir 0.
    expect(res.exitCode).not.toBe(0);
    expect(res.signal).not.toBeNull();
  }, 20_000);

  it("échoue proprement si la commande n'existe pas", async () => {
    const res = await runInPty({
      command: "commande-inexistante-xyz",
      args: [],
      cwd: await tmpDir(),
      env: { PATH: "/nexistepas" },
      onData: () => {},
    });
    expect(res.exitCode).not.toBe(0);
  });
});

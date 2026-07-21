import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveRubyEnv } from "../../src/sidecar/ruby-env.js";

const exec = promisify(execFile);

describe("resolveRubyEnv", () => {
  it("returns an environment where Ruby can load fastlane", async () => {
    const resolved = await resolveRubyEnv();
    expect(resolved).not.toBeNull();

    const { stdout } = await exec("ruby", ["-e", 'require "fastlane"; print "ok"'], {
      env: resolved!.env,
      timeout: 180_000,
    });
    expect(stdout).toBe("ok");
  }, 240_000);

  it("indicates where the chosen environment comes from", async () => {
    const resolved = await resolveRubyEnv();
    expect(["process", "launcher"]).toContain(resolved!.source);
  }, 240_000);

  it("memoizes the result rather than probing again on every call", async () => {
    const a = await resolveRubyEnv();
    const b = await resolveRubyEnv();
    expect(b).toBe(a);
  }, 240_000);
});

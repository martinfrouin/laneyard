import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveRubyEnv } from "../../src/sidecar/ruby-env.js";

const exec = promisify(execFile);

describe("resolveRubyEnv", () => {
  it("rend un environnement où Ruby sait charger fastlane", async () => {
    const resolved = await resolveRubyEnv();
    expect(resolved).not.toBeNull();

    const { stdout } = await exec("ruby", ["-e", 'require "fastlane"; print "ok"'], {
      env: resolved!.env,
      timeout: 180_000,
    });
    expect(stdout).toBe("ok");
  }, 240_000);

  it("indique d'où vient l'environnement retenu", async () => {
    const resolved = await resolveRubyEnv();
    expect(["process", "launcher"]).toContain(resolved!.source);
  }, 240_000);

  it("mémorise le résultat plutôt que de resonder à chaque appel", async () => {
    const a = await resolveRubyEnv();
    const b = await resolveRubyEnv();
    expect(b).toBe(a);
  }, 240_000);
});

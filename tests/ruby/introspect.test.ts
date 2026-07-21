import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveRubyEnv } from "../../src/sidecar/ruby-env.js";
import { tmpDir } from "../fixtures/repos.js";

const exec = promisify(execFile);
const SCRIPT = join(process.cwd(), "ruby", "introspect.rb");

async function projectWithFastfile(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-fl-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  await writeFile(join(dir, "fastlane", "Fastfile"), content, "utf8");
  return dir;
}

async function introspect(dir: string, cmd: string): Promise<unknown> {
  // The sidecar runs here without bundle: it needs the resolved environment.
  const ruby = await resolveRubyEnv();
  if (!ruby) throw new Error("fastlane not found for the current Ruby");

  const { stdout } = await exec("ruby", [SCRIPT, cmd, "--fastlane-dir", "fastlane"], {
    cwd: dir,
    env: ruby.env,
    timeout: 180_000,
  });
  return JSON.parse(stdout);
}

describe("introspect.rb lanes", () => {
  it("lists lanes with platform and description", async () => {
    const dir = await projectWithFastfile(`
      platform :ios do
        desc "Push a new beta build to TestFlight"
        lane :beta do
          increment_build_number
        end

        private_lane :helper do
        end
      end

      lane :global do
      end
    `);

    const res = (await introspect(dir, "lanes")) as {
      ok: boolean;
      lanes: { name: string; platform: string | null; description: string; private: boolean }[];
    };

    expect(res.ok).toBe(true);
    const beta = res.lanes.find((l) => l.name === "beta");
    expect(beta).toBeDefined();
    expect(beta!.platform).toBe("ios");
    expect(beta!.description).toBe("Push a new beta build to TestFlight");
    expect(res.lanes.find((l) => l.name === "global")?.platform).toBeNull();
    expect(res.lanes.find((l) => l.name === "helper")?.private).toBe(true);
  }, 180_000);

  it("returns a structured error on an invalid Fastfile", async () => {
    const dir = await projectWithFastfile("lane :beta do\n  # never closed\n");
    const res = (await introspect(dir, "lanes")) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error.length).toBeGreaterThan(0);
  }, 180_000);

  it("reads a Fastfile that calls an action at top level", async () => {
    // `default_platform(:ios)` is the first line of most real Fastfiles. Loading
    // a Fastfile runs it, so the action catalogue has to be in place first —
    // without it fastlane raises "Could not find action, lane or variable" and
    // the whole lane list is lost over an ordinary line.
    const dir = await projectWithFastfile(`
      default_platform(:ios)

      lane :beta do
      end
    `);

    const res = (await introspect(dir, "lanes")) as { ok: boolean; lanes: { name: string }[] };
    expect(res.ok).toBe(true);
    expect(res.lanes.map((l) => l.name)).toContain("beta");
  }, 180_000);
});

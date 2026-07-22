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

describe("introspect.rb uses", () => {
  it("reports the actions a lane calls, in order", async () => {
    const dir = await projectWithFastfile(`
      lane :beta do
        increment_build_number
        match(type: "appstore", readonly: true)
        build_app(scheme: "App")
      end
    `);
    const res = (await introspect(dir, "uses")) as {
      ok: boolean;
      lanes: { lane: string; actions: { name: string; args: Record<string, unknown> }[] }[];
    };

    expect(res.ok).toBe(true);
    const beta = res.lanes.find((l) => l.lane === "beta")!;
    expect(beta.actions.map((a) => a.name)).toEqual([
      "increment_build_number",
      "match",
      "build_app",
    ]);
  }, 180_000);

  it("reports literal keyword arguments, and only those", async () => {
    const dir = await projectWithFastfile(`
      lane :beta do
        match(type: "appstore", readonly: true, count: 3)
        build_app(scheme: ENV["SCHEME"])
      end
    `);
    const res = (await introspect(dir, "uses")) as any;
    const actions = res.lanes[0].actions;

    expect(actions[0].args).toEqual({ type: "appstore", readonly: true, count: 3 });
    // A value computed at runtime is not a literal: reporting a guess would be
    // worse than reporting nothing, because a checklist that lies is trusted.
    expect(actions[1].args).toEqual({});
  }, 180_000);

  it("sees through a platform block", async () => {
    const dir = await projectWithFastfile(`
      platform :ios do
        lane :beta do
          match(readonly: false)
        end
      end
    `);
    const res = (await introspect(dir, "uses")) as any;
    expect(res.lanes[0].lane).toBe("beta");
    expect(res.lanes[0].actions[0].args).toEqual({ readonly: false });
  }, 180_000);

  it("does not confuse a nested block for a lane's own calls", async () => {
    const dir = await projectWithFastfile(`
      lane :beta do
        if ENV["CLEAN"]
          clear_derived_data
        end
        build_app
      end
    `);
    const res = (await introspect(dir, "uses")) as any;
    // A conditional call is still a call the lane may make: it counts.
    expect(res.lanes[0].actions.map((a: any) => a.name)).toContain("clear_derived_data");
  }, 180_000);

  it("returns a structured error on an unparseable Fastfile", async () => {
    const dir = await projectWithFastfile("lane :beta do\n  # never closed\n");
    const res = (await introspect(dir, "uses")) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
  }, 180_000);
});

/**
 * The shapes a real Fastfile takes.
 *
 * Reading only the lane bodies was enough for the first of these and wrong for
 * the rest — and the rest are not exotic. Factoring a Fastfile into methods is
 * how a Fastfile stops being a thousand lines; a project whose every action sat
 * one method call away looked, from here, like a project that called no actions
 * at all. The checklist then said so, in green.
 */
describe("introspect.rb uses, across the shapes a Fastfile takes", () => {
  const actionsIn = (res: unknown): string[] => {
    const { lanes } = res as { lanes: { actions: { name: string }[] }[] };
    return [...new Set(lanes.flatMap((l) => l.actions.map((a) => a.name)))];
  };

  it("follows a call into a method this Fastfile defines", async () => {
    const dir = await projectWithFastfile(`
      def deploy_ios
        upload_to_testflight(skip_waiting_for_build_processing: true)
      end

      lane :release do
        deploy_ios
      end
    `);
    const res = await introspect(dir, "uses");
    expect(actionsIn(res)).toContain("upload_to_testflight");
  });

  it("follows a chain of methods, and through a block", async () => {
    const dir = await projectWithFastfile(`
      def with_env
        yield
      end

      def ship
        with_env { upload_to_play_store(track: "internal") }
      end

      lane :release do
        ship
      end
    `);
    const res = await introspect(dir, "uses");
    expect(actionsIn(res)).toContain("upload_to_play_store");
  });

  it("follows a module method called through its constant", async () => {
    const dir = await projectWithFastfile(`
      module Helpers
        def self.ship
          upload_to_testflight(skip_waiting_for_build_processing: true)
        end
      end

      lane :release do
        Helpers.ship
      end
    `);
    const res = await introspect(dir, "uses");
    expect(actionsIn(res)).toContain("upload_to_testflight");
  });

  it("keeps the literal arguments of an action found inside a method", async () => {
    const dir = await projectWithFastfile(`
      def ship
        upload_to_play_store(track: "internal", skip_upload_apk: true)
      end

      lane :release do
        ship
      end
    `);
    const { lanes } = (await introspect(dir, "uses")) as {
      lanes: { actions: { name: string; args: Record<string, unknown> }[] }[];
    };
    const call = lanes.flatMap((l) => l.actions).find((a) => a.name === "upload_to_play_store");
    expect(call?.args).toEqual({ track: "internal", skip_upload_apk: true });
  });

  // Two helpers calling each other must cost one walk, not a stack overflow
  // inside a sidecar that promised to answer with JSON whatever happens.
  it("survives methods that call each other", async () => {
    const dir = await projectWithFastfile(`
      def ping
        pong
      end

      def pong
        ping
        upload_to_testflight(skip_waiting_for_build_processing: true)
      end

      lane :release do
        ping
      end
    `);
    const res = (await introspect(dir, "uses")) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(actionsIn(res)).toContain("upload_to_testflight");
  });

  it("does not report Ruby called on a receiver as an action", async () => {
    const dir = await projectWithFastfile(`
      lane :release do
        UI.message("hello")
        File.join("a", "b")
      end
    `);
    expect(actionsIn(await introspect(dir, "uses"))).toEqual([]);
  });

  // The one shape no amount of reading this file will resolve — so it is
  // reported instead, and the checklist turns it into "could not tell".
  it("reports that the Fastfile imports lanes from elsewhere", async () => {
    const dir = await projectWithFastfile(`
      import "./Shared"

      lane :release do
        shared_upload
      end
    `);
    const res = (await introspect(dir, "uses")) as { imports: boolean };
    expect(res.imports).toBe(true);
  });

  it("says so plainly when nothing is imported", async () => {
    const dir = await projectWithFastfile(`
      lane :release do
        upload_to_testflight(skip_waiting_for_build_processing: true)
      end
    `);
    const res = (await introspect(dir, "uses")) as { imports: boolean };
    expect(res.imports).toBe(false);
  });
});

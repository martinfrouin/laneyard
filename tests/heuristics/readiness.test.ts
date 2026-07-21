import { describe, expect, it } from "vitest";
import {
  CHECKS,
  checkAppStoreConnect,
  checkBlockingActions,
  checkDependencies,
  checkMatch,
  checkRepository,
  runChecks,
} from "../../src/heuristics/readiness.js";
import type { Known, LaneUses, ReadinessInput } from "../../src/heuristics/readiness.js";

const known = <T>(value: T): Known<T> => ({ ok: true, value });
const unknown = <T>(reason: string): Known<T> => ({ ok: false, reason });

const lanes = (...ls: LaneUses[]): Known<LaneUses[]> => known(ls);

describe("checkRepository", () => {
  it("is ok when the remote answers", async () => {
    const check = await checkRepository(async () => "refs/heads/main");
    expect(check.id).toBe("repository");
    expect(check.state).toBe("ok");
  });

  it("warns with the probe's own words when it fails", async () => {
    const check = await checkRepository(async () => {
      throw new Error("git ls-remote <repository> failed: Permission denied");
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/Permission denied/);
    expect(check.fix).toMatch(/ssh_key/);
  });

  it("never throws, whatever the probe rejects with", async () => {
    await expect(checkRepository(() => Promise.reject("a bare string"))).resolves.toMatchObject({
      state: "warn",
    });
  });
});

describe("checkDependencies", () => {
  const never = async () => {
    throw new Error("should not be called");
  };

  it("is ok when a Gemfile's bundle checks out", async () => {
    const check = await checkDependencies({
      workspace: known({ hasGemfile: true }),
      bundleCheck: async () => "The Gemfile's dependencies are satisfied",
      findFastlane: never,
    });
    expect(check.id).toBe("dependencies");
    expect(check.state).toBe("ok");
  });

  it("warns when the bundle is not installed, and says how to install it", async () => {
    const check = await checkDependencies({
      workspace: known({ hasGemfile: true }),
      bundleCheck: async () => {
        throw new Error("Install missing gems with `bundle install`");
      },
      findFastlane: never,
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/missing gems/);
    expect(check.fix).toMatch(/bundle install/);
  });

  it("falls back to a system fastlane when there is no Gemfile, and says so", async () => {
    const check = await checkDependencies({
      workspace: known({ hasGemfile: false }),
      bundleCheck: never,
      findFastlane: async () => "/usr/local/bin/fastlane",
    });
    expect(check.state).toBe("ok");
    // The absence of a Gemfile is not a failure, but it is a fact worth stating:
    // nothing pins the version a run will get.
    expect(check.detail).toMatch(/\/usr\/local\/bin\/fastlane/);
    expect(check.detail).toMatch(/nothing pins/);
  });

  it("warns when there is neither a Gemfile nor a fastlane on the PATH", async () => {
    const check = await checkDependencies({
      workspace: known({ hasGemfile: false }),
      bundleCheck: never,
      findFastlane: async () => null,
    });
    expect(check.state).toBe("warn");
    expect(check.fix).toMatch(/Gemfile/);
  });

  it("is unknown when the workspace could not be inspected", async () => {
    const check = await checkDependencies({
      workspace: unknown("the clone failed"),
      bundleCheck: never,
      findFastlane: never,
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/the clone failed/);
  });

  it("is unknown rather than throwing when the search for fastlane fails", async () => {
    const check = await checkDependencies({
      workspace: known({ hasGemfile: false }),
      bundleCheck: never,
      findFastlane: async () => {
        throw new Error("spawn which ENOENT");
      },
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/ENOENT/);
  });
});

describe("checkAppStoreConnect", () => {
  it("is ok on an API key secret, whatever the suffix", () => {
    const check = checkAppStoreConnect(["APP_STORE_CONNECT_API_KEY_ID", "OTHER"]);
    expect(check.id).toBe("app-store-connect");
    expect(check.state).toBe("ok");
  });

  it("warns on a session alone, because sessions expire", () => {
    const check = checkAppStoreConnect(["FASTLANE_SESSION"]);
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/expire/);
    expect(check.fixIn).toBe("secrets");
  });

  it("prefers the API key when both are stored", () => {
    const check = checkAppStoreConnect(["FASTLANE_SESSION", "APP_STORE_CONNECT_API_KEY_KEY"]);
    expect(check.state).toBe("ok");
  });

  it("warns when neither is stored, and points at the secrets tab", () => {
    const check = checkAppStoreConnect([]);
    expect(check.state).toBe("warn");
    expect(check.fixIn).toBe("secrets");
  });
});

describe("checkMatch", () => {
  it("is ok when no lane uses match", () => {
    const check = checkMatch(lanes({ lane: "beta", actions: [{ name: "build_app", args: {} }] }), []);
    expect(check.id).toBe("match");
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/no lane/);
  });

  it("warns when a lane uses match and MATCH_PASSWORD is not stored", () => {
    const check = checkMatch(
      lanes({ lane: "beta", actions: [{ name: "match", args: { readonly: true } }] }),
      [],
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/MATCH_PASSWORD/);
    expect(check.fixIn).toBe("secrets");
  });

  it("sees sync_code_signing as match", () => {
    const check = checkMatch(
      lanes({ lane: "beta", actions: [{ name: "sync_code_signing", args: { readonly: true } }] }),
      [],
    );
    expect(check.state).toBe("warn");
  });

  it("warns on readonly: false even when the password is stored", () => {
    const check = checkMatch(
      lanes({ lane: "beta", actions: [{ name: "match", args: { readonly: false } }] }),
      ["MATCH_PASSWORD"],
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/beta/);
    expect(check.fix).toMatch(/readonly: true/);
    // Editing a Fastfile is not something Laneyard does for you: no link.
    expect(check.fixIn).toBeUndefined();
  });

  it("is unknown when readonly is not a literal, rather than green", () => {
    // `match(readonly: ENV["RO"])` reaches us with an empty args hash. Calling
    // that ok would be the checklist claiming to know something it does not.
    const check = checkMatch(
      lanes({ lane: "beta", actions: [{ name: "match", args: {} }] }),
      ["MATCH_PASSWORD"],
    );
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/literal/);
  });

  it("is ok when the password is stored and every call is readonly", () => {
    const check = checkMatch(
      lanes(
        { lane: "beta", actions: [{ name: "match", args: { readonly: true } }] },
        { lane: "release", actions: [{ name: "match", args: { readonly: true } }] },
      ),
      ["MATCH_PASSWORD"],
    );
    expect(check.state).toBe("ok");
  });

  it("is unknown when the lanes could not be read", () => {
    const check = checkMatch(unknown("no Ruby on this machine"), ["MATCH_PASSWORD"]);
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/no Ruby/);
  });
});

describe("checkBlockingActions", () => {
  it("is ok when nothing in the table is called", () => {
    const check = checkBlockingActions(
      lanes({ lane: "beta", actions: [{ name: "build_app", args: {} }] }),
    );
    expect(check.id).toBe("blocking-actions");
    expect(check.state).toBe("ok");
  });

  it("names the lane and the action that would stop and ask", () => {
    const check = checkBlockingActions(
      lanes({ lane: "beta", actions: [{ name: "prompt", args: {} }] }),
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/beta/);
    expect(check.detail).toMatch(/prompt/);
    expect(check.fix).toMatch(/Remove it/);
  });

  it("reports each lane that has one", () => {
    const check = checkBlockingActions(
      lanes(
        { lane: "beta", actions: [{ name: "prompt", args: {} }] },
        { lane: "release", actions: [{ name: "sigh", args: {} }] },
      ),
    );
    expect(check.detail).toMatch(/beta/);
    expect(check.detail).toMatch(/release/);
  });

  it("is unknown when the lanes could not be read", () => {
    const check = checkBlockingActions(unknown("unparseable Fastfile"));
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/unparseable/);
  });
});

describe("runChecks", () => {
  const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
    probeRepository: async () => "ok",
    dependencies: {
      workspace: known({ hasGemfile: true }),
      bundleCheck: async () => "satisfied",
      findFastlane: async () => null,
    },
    secretKeys: ["APP_STORE_CONNECT_API_KEY_ID", "MATCH_PASSWORD"],
    uses: lanes({ lane: "beta", actions: [{ name: "match", args: { readonly: true } }] }),
    ...over,
  });

  it("returns the five checks, in the table's order", async () => {
    const checks = await runChecks(input());
    expect(checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
    expect(checks).toHaveLength(5);
    expect(checks.every((c) => c.state === "ok")).toBe(true);
  });

  it("turns a check that throws into an unknown one, never losing the others", async () => {
    // A check body that blows up on something it never guarded — here a list of
    // secrets that isn't a list. Each check promises not to throw; the wrapper
    // exists because that promise is worth what the next edit makes it worth,
    // and a checklist that disappears is what teaches people to ignore it.
    const checks = await runChecks(input({ secretKeys: null as unknown as string[] }));
    expect(checks).toHaveLength(5);
    const appStoreConnect = checks.find((c) => c.id === "app-store-connect")!;
    expect(appStoreConnect.state).toBe("unknown");
    expect(appStoreConnect.detail).toMatch(/the check itself failed/);
    // The others are unharmed.
    expect(checks.find((c) => c.id === "repository")!.state).toBe("ok");
  });

  it("gives every check a title", async () => {
    const checks = await runChecks(input());
    expect(checks.every((c) => c.title.length > 0)).toBe(true);
  });
});

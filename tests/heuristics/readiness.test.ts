import { describe, expect, it } from "vitest";
import {
  SECTIONS,
  checkAndroidKeystore,
  checkAppStoreConnect,
  checkBlockingActions,
  checkDependencies,
  checkMatch,
  checkPlayStore,
  checkRepository,
  runChecklist,
} from "../../src/heuristics/readiness.js";
import type {
  Check,
  Known,
  LaneUses,
  ReadinessInput,
  ReadinessSection,
} from "../../src/heuristics/readiness.js";
import type { Platform } from "../../src/heuristics/platforms.js";

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

describe("checkAndroidKeystore", () => {
  it("is ok when no lane builds with gradle", () => {
    const check = checkAndroidKeystore(
      lanes({ lane: "test", actions: [{ name: "run_tests", args: {} }] }),
      [],
    );
    expect(check.id).toBe("android-keystore");
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/no lane/);
  });

  it("is ok when a gradle lane passes no keystore of its own", () => {
    // What it says is exactly what it read: no `storeFile`, no `storePassword`.
    // It does not claim the build is unsigned — only that nothing in the lane
    // hands gradle a keystore to unlock.
    const check = checkAndroidKeystore(
      lanes({ lane: "beta", actions: [{ name: "gradle", args: { task: "assemble" } }] }),
      [],
    );
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/storeFile/);
  });

  it("warns when a lane passes a keystore and no password is in the vault", () => {
    const check = checkAndroidKeystore(
      lanes({
        lane: "beta",
        actions: [{ name: "gradle", args: { task: "bundle", storeFile: "release.keystore" } }],
      }),
      ["MATCH_PASSWORD"],
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/beta/);
    expect(check.fixIn).toBe("secrets");
  });

  it("is ok once a keystore password is in the vault", () => {
    const check = checkAndroidKeystore(
      lanes({ lane: "beta", actions: [{ name: "gradle", args: { storeFile: "release.keystore" } }] }),
      ["ANDROID_KEYSTORE_PASSWORD"],
    );
    expect(check.state).toBe("ok");
  });

  it("sees build_android_app as gradle", () => {
    const check = checkAndroidKeystore(
      lanes({ lane: "beta", actions: [{ name: "build_android_app", args: { storeFile: "k.jks" } }] }),
      [],
    );
    expect(check.state).toBe("warn");
  });

  it("is ok when the call carries the passphrase itself", () => {
    const check = checkAndroidKeystore(
      lanes({
        lane: "beta",
        actions: [{ name: "gradle", args: { storeFile: "k.jks", storePassword: "hunter2" } }],
      }),
      [],
    );
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/the call itself/);
  });

  it("never guesses at an argument that was not a literal", () => {
    // `gradle(storePassword: ENV["PW"])` reaches us with an empty args hash,
    // exactly as `match(readonly: ENV["RO"])` does. Neither one is guessed at.
    const check = checkAndroidKeystore(
      lanes({ lane: "beta", actions: [{ name: "gradle", args: {} }] }),
      [],
    );
    expect(check.state).toBe("ok");
    expect(check.detail).not.toMatch(/hunter2/);
  });

  it("is unknown when the lanes could not be read", () => {
    const check = checkAndroidKeystore(unknown("unparseable Fastfile"), []);
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/unparseable/);
  });
});

describe("checkPlayStore", () => {
  it("is ok when no lane uploads", () => {
    const check = checkPlayStore(
      lanes({ lane: "beta", actions: [{ name: "gradle", args: {} }] }),
      [],
    );
    expect(check.id).toBe("play-store");
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/no lane/);
  });

  it("warns when a lane uploads and no service account is in the vault", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "upload_to_play_store", args: {} }] }),
      [],
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/release/);
    expect(check.fixIn).toBe("secrets");
  });

  it("sees supply as upload_to_play_store", () => {
    const check = checkPlayStore(lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }), []);
    expect(check.state).toBe("warn");
  });

  it("is ok when the service account JSON is in the vault", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }),
      ["SUPPLY_JSON_KEY_DATA"],
    );
    expect(check.state).toBe("ok");
  });

  it("says it could not tell when the lane names a key file instead", () => {
    // A path in a Fastfile says nothing about whether the file is on this
    // machine. That is a "could not tell", not a warning and not a tick.
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: { json_key: "play.json" } }] }),
      [],
    );
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/json_key/);
  });

  it("is unknown when the lanes could not be read", () => {
    const check = checkPlayStore(unknown("no Ruby on this machine"), []);
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/no Ruby/);
  });
});

describe("runChecklist", () => {
  const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
    probeRepository: async () => "ok",
    dependencies: {
      workspace: known({ hasGemfile: true }),
      bundleCheck: async () => "satisfied",
      findFastlane: async () => null,
    },
    secretKeys: ["APP_STORE_CONNECT_API_KEY_ID", "MATCH_PASSWORD"],
    uses: lanes({ lane: "beta", actions: [{ name: "match", args: { readonly: true } }] }),
    platforms: known<Platform[]>(["ios"]),
    ...over,
  });

  const ids = (sections: ReadinessSection[]): string[] =>
    sections.flatMap((s) => s.checks.map((c: Check) => c.id));
  const section = (sections: ReadinessSection[], platform: string): ReadinessSection | undefined =>
    sections.find((s) => s.platform === platform);

  it("shows the shared checks and the iOS ones on an iOS project", async () => {
    const sections = await runChecklist(input());
    expect(sections.map((s) => s.platform)).toEqual(["all", "ios"]);
    expect(ids(sections)).toContain("app-store-connect");
    expect(ids(sections)).not.toContain("android-keystore");
    expect(ids(sections).every((id) => id.length > 0)).toBe(true);
  });

  it("never shows the iOS checks to a project that only builds for Android", async () => {
    // One irrelevant warning teaches someone to ignore the whole screen. An
    // Android project told off for having no App Store Connect key is exactly
    // that warning.
    const sections = await runChecklist(input({ platforms: known<Platform[]>(["android"]) }));
    expect(sections.map((s) => s.platform)).toEqual(["all", "android"]);
    expect(ids(sections)).not.toContain("app-store-connect");
    expect(ids(sections)).not.toContain("match");
    expect(ids(sections)).toContain("play-store");
  });

  it("shows both when a project builds for both", async () => {
    const sections = await runChecklist(input({ platforms: known<Platform[]>(["ios", "android"]) }));
    expect(sections.map((s) => s.platform)).toEqual(["all", "ios", "android"]);
  });

  it("shows the shared section and one line when no platform is known", async () => {
    const sections = await runChecklist(input({ platforms: known<Platform[]>([]) }));
    expect(sections.map((s) => s.platform)).toEqual(["all"]);

    const note = section(sections, "all")!.checks.at(-1)!;
    expect(note.state).toBe("unknown");
    expect(note.detail).toMatch(/no platform/i);
    // And how to say so, in the file where it belongs.
    expect(note.fix).toMatch(/laneyard\.yml/);
    expect(note.fix).toMatch(/platforms/);
  });

  it("keeps the shared section's own checks whole when there is no platform", async () => {
    const sections = await runChecklist(input({ platforms: known<Platform[]>([]) }));
    expect(ids(sections)).toContain("repository");
    expect(ids(sections)).toContain("dependencies");
    expect(ids(sections)).toContain("blocking-actions");
  });

  it("returns the sections and checks in the table's order", async () => {
    const sections = await runChecklist(input({ platforms: known<Platform[]>(["ios", "android"]) }));
    expect(sections.map((s) => s.platform)).toEqual(SECTIONS.map((s) => s.platform));
    for (const [i, s] of sections.entries()) {
      expect(s.checks.map((c) => c.id)).toEqual(SECTIONS[i]!.checks.map((c) => c.id));
    }
  });

  it("turns a check that throws into an unknown one, never losing the others", async () => {
    // A check body that blows up on something it never guarded — here a list of
    // secrets that isn't a list. Each check promises not to throw; the wrapper
    // exists because that promise is worth what the next edit makes it worth,
    // and a checklist that disappears is what teaches people to ignore it.
    const sections = await runChecklist(input({ secretKeys: null as unknown as string[] }));
    const appStoreConnect = section(sections, "ios")!.checks.find((c) => c.id === "app-store-connect")!;
    expect(appStoreConnect.state).toBe("unknown");
    expect(appStoreConnect.detail).toMatch(/the check itself failed/);
    // The others are unharmed.
    expect(section(sections, "all")!.checks.find((c) => c.id === "repository")!.state).toBe("ok");
  });

  it("does not throw when nothing sensible was passed for the platforms", async () => {
    const sections = await runChecklist(input({ platforms: null as unknown as Known<Platform[]> }));
    expect(sections.map((s) => s.platform)).toEqual(["all"]);
  });

  it("gives every check a title", async () => {
    const sections = await runChecklist(input({ platforms: known<Platform[]>(["ios", "android"]) }));
    expect(sections.flatMap((s) => s.checks).every((c) => c.title.length > 0)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  SECTIONS,
  checkAndroidKeystore,
  checkAppStoreConnect,
  checkBlockingActions,
  checkDependencies,
  checkEnvironment,
  checkReleaseSigning,
  checkMatch,
  checkPlayStore,
  checkRepository,
  runChecklist,
} from "../../src/heuristics/readiness.js";
import {
  READ_EVERYTHING,
} from "../../src/heuristics/readiness.js";
import type {
  AppStoreConnectInput,
  Unread,
  Check,
  Known,
  LaneUses,
  ReadinessInput,
  ReadinessSection,
} from "../../src/heuristics/readiness.js";
import type { Platform } from "../../src/heuristics/platforms.js";
import { NO_SIGNING_FACTS } from "../../src/heuristics/android-signing.js";
import type { SigningFacts } from "../../src/heuristics/android-signing.js";
import { NO_APPFILE } from "../../src/heuristics/appfile.js";

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
    expect(check.fix).toMatch(/git_auth/);
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
    expect(check.detail).toMatch(/unpinned/);
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
  /**
   * Only the vault differs in most of these; the other three places say nothing.
   *
   * The default lane uploads, because a key is wanted by a lane and not by a
   * platform: without something that signs in to Apple, every case below would
   * be answered "nothing here needs a key" before it got as far as the vault.
   */
  const asc = (secretKeys: string[], over: Partial<AppStoreConnectInput> = {}) =>
    checkAppStoreConnect({
      secretKeys,
      uses: lanes({ lane: "beta", actions: [{ name: "upload_to_testflight", args: {} }] }),
      keyFilesInRepo: known<string[]>([]),
      appfile: known(NO_APPFILE),
      ...over,
    });

  it("is ok on an API key secret, whatever the suffix", () => {
    const check = asc(["APP_STORE_CONNECT_API_KEY_ID", "OTHER"]);
    expect(check.id).toBe("app-store-connect");
    expect(check.state).toBe("ok");
  });

  it("warns on a session alone, because sessions expire", () => {
    const check = asc(["FASTLANE_SESSION"]);
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/expire/);
    expect(check.fixIn).toBe("signing");
  });

  it("prefers the API key when both are stored", () => {
    const check = asc(["FASTLANE_SESSION", "APP_STORE_CONNECT_API_KEY_KEY"]);
    expect(check.state).toBe("ok");
  });

  it("warns when nothing anywhere holds a key, and points at the signing tab", () => {
    const check = asc([]);
    expect(check.state).toBe("warn");
    expect(check.fixIn).toBe("signing");
  });

  // The whole point of looking past the vault: a project that arranged its key
  // in the Fastfile years ago used to be told it had none.
  it("sees a key loaded by the lane itself, and says it cannot tell", () => {
    const check = asc([], {
      uses: lanes({
        lane: "release",
        actions: [{ name: "app_store_connect_api_key", args: { key_filepath: "./AuthKey.p8" } }],
      }),
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/release/);
    expect(check.detail).not.toMatch(/no App Store Connect credential/);
  });

  it("sees the key named as an argument to an upload action", () => {
    const check = asc([], {
      uses: lanes({
        lane: "beta",
        actions: [{ name: "upload_to_testflight", args: { api_key_path: "key.json" } }],
      }),
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/beta/);
  });

  it("sees a .p8 the repository carries", () => {
    const check = asc([], { keyFilesInRepo: known(["fastlane/AuthKey_ABC123.p8"]) });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/AuthKey_ABC123\.p8/);
  });

  it("still prefers the vault over anything found in the repository", () => {
    const check = asc(["APP_STORE_CONNECT_API_KEY_ID"], {
      keyFilesInRepo: known(["AuthKey.p8"]),
    });
    expect(check.state).toBe("ok");
  });

  it("warns about an Apple ID alone, because 2FA stops the run", () => {
    const check = asc([], {
      appfile: known({ ...NO_APPFILE, appleId: { kind: "literal" as const, value: "me@x.com" } }),
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/two-factor/);
  });

  it("takes a block as an answer, and says what a run does with it", () => {
    const check = asc([], { blocks: ["apple_asc"] });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/block/);
    // What Laneyard does, not what the user must do next.
    expect(check.detail).toMatch(/in the vault/);
    expect(check.fix).toBeUndefined();
  });

  it("stops greening a name no lane can see", () => {
    // `API_KEY` prefix-matched `APP_STORE_CONNECT_API_KEY_P8`, a name that
    // appears nowhere in fastlane: Laneyard's own screen invented it. The value
    // is in the vault, it reaches nothing, and the tick said otherwise.
    const check = asc(["APP_STORE_CONNECT_API_KEY_P8"]);
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/no lane can see it/);
    expect(check.fix).toMatch(/block/);
    expect(check.fixIn).toBe("signing");
  });

  it("still greens the names fastlane really does read", () => {
    // The narrowing must not take the working names with it.
    for (const name of [
      "APP_STORE_CONNECT_API_KEY_ID",
      "APP_STORE_CONNECT_API_KEY_KEY_ID",
      "APP_STORE_CONNECT_API_KEY_ISSUER_ID",
      "APP_STORE_CONNECT_API_KEY_KEY_FILEPATH",
    ]) {
      expect(asc([name]).state).toBe("ok");
    }
  });

  it("asks nothing of a project whose lanes never sign in to Apple", () => {
    // A lane that builds an artifact and stops. Nothing is uploaded, no
    // certificate is fetched, and a key would sit there unread.
    const check = asc([], {
      uses: lanes({ lane: "build", actions: [{ name: "build_app", args: {} }] }),
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/no lane signs in/);
    expect(check.fix).toBeUndefined();
  });

  it("counts match among the lanes that sign in, because it does", () => {
    const check = asc([], {
      uses: lanes({ lane: "certs", actions: [{ name: "match", args: { readonly: true } }] }),
    });
    expect(check.state).toBe("warn");
  });

  it("does not call a build-only project settled when the reading was partial", () => {
    const check = asc([], {
      uses: lanes({ lane: "build", actions: [{ name: "build_app", args: {} }] }),
      unread: known({ imports: true, customActions: false }),
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/imports lanes from elsewhere/);
  });

  it("says it could not tell when the lanes were unreadable and the vault is empty", () => {
    const check = asc([], { uses: unknown("no Ruby on this machine") });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/no Ruby/);
  });

  it("answers from the vault even when the lanes could not be read", () => {
    // The vault's answer owes nothing to the Fastfile.
    expect(asc(["APP_STORE_CONNECT_API_KEY_ID"], { uses: unknown("no Ruby") }).state).toBe("ok");
    expect(asc([], { uses: unknown("no Ruby"), blocks: ["apple_asc"] }).state).toBe("ok");
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
  // Superseded: this check only runs in the Android section, so seeing no
  // gradle action means the build is driven by something else — flutter and
  // react-native both run gradle underneath — not that no keystore is needed.
  it("does not tick merely because it saw no gradle action", () => {
    const check = checkAndroidKeystore(
      lanes({ lane: "test", actions: [{ name: "run_tests", args: {} }] }),
      [],
    );
    expect(check.id).toBe("android-keystore");
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/no lane seen handing gradle a keystore/);
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
    expect(check.fixIn).toBe("signing");
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

  it("stops asking for a password the user already gave", () => {
    // A block carries the keystore and both passphrases. Telling that user to
    // store `ANDROID_KEYSTORE_PASSWORD` as well would be asking them to enter
    // the same secret twice, in two places, and keep them in step.
    const check = checkAndroidKeystore(
      lanes({ lane: "beta", actions: [{ name: "gradle", args: { storeFile: "k.jks" } }] }),
      [],
      known(READ_EVERYTHING),
      ["android_keystore"],
    );
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/block/);
  });

  it("answers from the block even when no gradle call was seen", () => {
    // The flutter case: gradle runs, but nothing in the Fastfile says so. The
    // question is whether anything stops to ask for a passphrase, and a block
    // means nothing can.
    const check = checkAndroidKeystore(
      lanes({ lane: "beta", actions: [{ name: "sh", args: {} }] }),
      [],
      known(READ_EVERYTHING),
      ["android_keystore"],
    );
    expect(check.state).toBe("ok");
  });

  it("still accepts the old loose secret", () => {
    const check = checkAndroidKeystore(
      lanes({ lane: "beta", actions: [{ name: "gradle", args: { storeFile: "k.jks" } }] }),
      ["ANDROID_KEYSTORE_PASSWORD"],
      known(READ_EVERYTHING),
      [],
    );
    expect(check.state).toBe("ok");
  });

  it("recommends the block rather than an edit to the lane", () => {
    const check = checkAndroidKeystore(
      lanes({ lane: "beta", actions: [{ name: "gradle", args: { storeFile: "k.jks" } }] }),
      [],
    );
    expect(check.state).toBe("warn");
    expect(check.fix).toMatch(/keystore block/);
    expect(check.fix).not.toMatch(/ENV\[/);
    expect(check.fix).not.toMatch(/storePassword:/);
  });
});

describe("checkPlayStore", () => {
  it("is ok when no lane uploads", () => {
    const check = checkPlayStore(
      lanes({ lane: "beta", actions: [{ name: "gradle", args: {} }] }),
      [],
      known(NO_APPFILE),
    );
    expect(check.id).toBe("play-store");
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/no lane/);
  });

  it("warns when a lane uploads and no service account is in the vault", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "upload_to_play_store", args: {} }] }),
      [],
      known(NO_APPFILE),
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/release/);
    expect(check.fixIn).toBe("signing");
  });

  it("sees supply as upload_to_play_store", () => {
    const check = checkPlayStore(lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }), [], known(NO_APPFILE));
    expect(check.state).toBe("warn");
  });

  it("is ok when the service account JSON is in the vault", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }),
      ["SUPPLY_JSON_KEY_DATA"],
      known(NO_APPFILE),
    );
    expect(check.state).toBe("ok");
  });

  it("says it could not tell when the lane names a key file instead", () => {
    // A path in a Fastfile says nothing about whether the file is on this
    // machine. That is a "could not tell", not a warning and not a tick.
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: { json_key: "play.json" } }] }),
      [],
      known(NO_APPFILE),
    );
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/supplies its own service account/);
  });

  /**
   * The inconsistency this pairs against, seen on a real project: the same lane
   * supplying an App Store Connect key was told "could not tell", while the very
   * same lane supplying a Play Store key from an environment variable was told
   * it had no credential at all. One situation, a shrug and a warning.
   *
   * The cause was reading only literal arguments: `json_key: ENV.fetch("…")`
   * leaves nothing in `args`, so the credential looked absent rather than
   * unreadable.
   */
  it("counts a service account named through a variable, not only a literal path", () => {
    const check = checkPlayStore(
      lanes({
        lane: "release",
        actions: [{ name: "upload_to_play_store", args: { track: "internal" }, given: ["track", "json_key"] }],
      }),
      [],
      known(NO_APPFILE),
    );
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/supplies its own service account/);
  });

  it("still warns when the lane names no credential at all", () => {
    const check = checkPlayStore(
      lanes({
        lane: "release",
        actions: [{ name: "upload_to_play_store", args: { track: "internal" }, given: ["track"] }],
      }),
      [],
      known(NO_APPFILE),
    );
    expect(check.state).toBe("warn");
  });

  it("is unknown when the lanes could not be read", () => {
    const check = checkPlayStore(unknown("no Ruby on this machine"), [], known(NO_APPFILE));
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/no Ruby/);
  });

  // Where a project older than Laneyard actually keeps this. Reported as "could
  // not tell" rather than warned about: the credential is arranged, and whether
  // the file is on this machine is not a question the Appfile answers.
  it("sees json_key_file in the Appfile", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }),
      [],
      known({ ...NO_APPFILE, jsonKeyFile: { kind: "literal" as const, value: "play.json" } }),
    );
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/play\.json/);
    expect(check.detail).not.toMatch(/no service account/);
  });

  it("says so plainly when the Appfile computes the path", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }),
      [],
      known({ ...NO_APPFILE, jsonKeyFile: { kind: "computed" as const } }),
    );
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/computes `json_key_file`/);
  });

  it("sees json_key_data in the Appfile", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }),
      [],
      known({ ...NO_APPFILE, jsonKeyData: { kind: "computed" as const } }),
    );
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/json_key_data/);
  });

  it("still prefers the vault over the Appfile", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }),
      ["SUPPLY_JSON_KEY_DATA"],
      known({ ...NO_APPFILE, jsonKeyFile: { kind: "literal" as const, value: "play.json" } }),
    );
    expect(check.state).toBe("ok");
  });

  it("takes a block as an answer", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }),
      [],
      known(NO_APPFILE),
      known(READ_EVERYTHING),
      ["play_service_account"],
    );
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/block/);
  });

  it("still accepts the old loose secrets", () => {
    // `SUPPLY_JSON_KEY_DATA` is still a name supply reads, and an installation
    // that stored one before blocks existed is not asked to move it.
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }),
      ["SUPPLY_JSON_KEY_DATA"],
      known(NO_APPFILE),
      known(READ_EVERYTHING),
      [],
    );
    expect(check.state).toBe("ok");
  });

  it("does not ask a build-only project for a service account", () => {
    // Nothing is uploaded anywhere, so nothing needs uploading credentials.
    const check = checkPlayStore(
      lanes({ lane: "build", actions: [{ name: "gradle", args: { task: "bundle" } }] }),
      [],
      known(NO_APPFILE),
      known(READ_EVERYTHING),
      [],
    );
    expect(check.state).toBe("ok");
    expect(check.fix).toBeUndefined();
  });

  it("recommends the block when neither route holds anything", () => {
    const check = checkPlayStore(
      lanes({ lane: "release", actions: [{ name: "supply", args: {} }] }),
      [],
      known(NO_APPFILE),
    );
    expect(check.state).toBe("warn");
    expect(check.fix).toMatch(/Play Store block/);
  });
});

/**
 * The half of the answer that is about not lying.
 *
 * Four checks used to conclude something from having found nothing, and finding
 * nothing is exactly what a parser does when the lanes it was reading call into
 * a file it never opened. Each of these asserts the same shape: same inputs,
 * and the verdict turns from a statement into "could not tell" the moment the
 * reading is known to have been partial.
 */
describe("a check that found nothing says so honestly when the reading was partial", () => {
  const hidden = (over: Partial<Unread>): Known<Unread> =>
    known({ ...READ_EVERYTHING, ...over });

  const uploads = lanes({ lane: "release", actions: [{ name: "supply", args: {} }] });
  const nothing = lanes({ lane: "release", actions: [{ name: "helper", args: {} }] });

  it("play store: a tick when everything was read", () => {
    const check = checkPlayStore(nothing, [], known(NO_APPFILE), known(READ_EVERYTHING));
    expect(check.state).toBe("ok");
  });

  // The exact bug: a project whose upload sits behind `import` was told, in
  // green, that no lane uploads to the Play Store.
  it("play store: could-not-tell when the Fastfile imports lanes", () => {
    const check = checkPlayStore(nothing, [], known(NO_APPFILE), hidden({ imports: true }));
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/imports lanes from elsewhere/);
  });

  it("play store: could-not-tell when the project has custom actions", () => {
    const check = checkPlayStore(nothing, [], known(NO_APPFILE), hidden({ customActions: true }));
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/fastlane\/actions/);
  });

  // Blindness only matters where the conclusion came from absence. An upload
  // that *was* seen is still an upload, and the verdict must not go soft.
  it("play store: a lane that was seen uploading still warns, blind or not", () => {
    const check = checkPlayStore(uploads, [], known(NO_APPFILE), hidden({ imports: true }));
    expect(check.state).toBe("warn");
  });

  it("android keystore: could-not-tell instead of \"no lane builds with gradle\"", () => {
    const check = checkAndroidKeystore(nothing, [], hidden({ customActions: true }));
    expect(check.state).toBe("unknown");
  });

  /**
   * The check only runs in the Android section, so getting here at all means
   * the project builds for Android. `flutter build appbundle` runs gradle
   * underneath and the signing lives in `key.properties` — invisible from a
   * Fastfile, and previously ticked as though it were settled.
   */
  it("android keystore: never ticks merely because no gradle action was seen", () => {
    const check = checkAndroidKeystore(nothing, [], known(READ_EVERYTHING));
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/key\.properties/);
  });

  it("blocking actions: could-not-tell instead of a clean bill", () => {
    const check = checkBlockingActions(nothing, hidden({ imports: true }));
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/no lane seen calling/);
  });

  it("app store connect: does not claim the lanes hold no key when it could not read them", () => {
    const check = checkAppStoreConnect({
      secretKeys: [],
      uses: nothing,
      keyFilesInRepo: known<string[]>([]),
      appfile: known(NO_APPFILE),
      unread: hidden({ imports: true }),
    });
    expect(check.state).toBe("unknown");
  });

  it("names both reasons when both apply", () => {
    const check = checkPlayStore(
      nothing,
      [],
      known(NO_APPFILE),
      hidden({ imports: true, customActions: true }),
    );
    expect(check.detail).toMatch(/imports lanes from elsewhere and the project defines its own/);
  });

  // An unreadable Fastfile already fails earlier, on `uses`. This only asserts
  // that an unknown `unread` never invents a reason.
  it("stays quiet when the blindness itself could not be established", () => {
    const check = checkPlayStore(nothing, [], known(NO_APPFILE), unknown("no clone"));
    expect(check.state).toBe("ok");
  });
});

/**
 * The complaint that produced this: one project, two stores, two verdicts.
 *
 * A lane that supplies its own App Store Connect key and its own Play Store
 * service account — both from environment variables — must be told the same
 * thing about both. Anything else reads as a bug in the checklist, and it was.
 */
describe("the two store credentials answer alike for the same situation", () => {
  const supplyingBoth = lanes({
    lane: "deploy",
    actions: [
      { name: "app_store_connect_api_key", args: {}, given: ["key_id", "issuer_id", "key_filepath"] },
      { name: "upload_to_play_store", args: { track: "internal" }, given: ["track", "json_key"] },
    ],
  });

  it("both say could-not-tell rather than one warning and one shrugging", () => {
    const ios = checkAppStoreConnect({
      secretKeys: [],
      uses: supplyingBoth,
      keyFilesInRepo: known<string[]>([]),
      appfile: known(NO_APPFILE),
    });
    const android = checkPlayStore(supplyingBoth, [], known(NO_APPFILE));

    expect(ios.state).toBe("unknown");
    expect(android.state).toBe("unknown");
    expect(ios.state).toBe(android.state);
  });

  it("and word it the same way, so the two lines read as one situation", () => {
    const ios = checkAppStoreConnect({
      secretKeys: [],
      uses: supplyingBoth,
      keyFilesInRepo: known<string[]>([]),
      appfile: known(NO_APPFILE),
    });
    const android = checkPlayStore(supplyingBoth, [], known(NO_APPFILE));

    expect(ios.detail).toMatch(/supplies its own/);
    expect(android.detail).toMatch(/supplies its own/);
    expect(ios.detail).toMatch(/not something a Fastfile says/);
    expect(android.detail).toMatch(/not something a Fastfile says/);
  });
});

/**
 * The variables a run needs, which is the one credential question a Fastfile
 * can actually answer — and the reason a project whose secrets live in a
 * gitignored `fastlane/.env` used to get no explanation at all.
 */
describe("checkEnvironment", () => {
  const env = (over: Partial<Parameters<typeof checkEnvironment>[0]> = {}) =>
    checkEnvironment({
      uses: lanes(),
      secretKeys: [],
      serverEnv: [],
      declared: [],
      unread: known(READ_EVERYTHING),
      ...over,
    });

  const reading = (...names: string[]) =>
    lanes({ lane: "deploy", actions: [], env: names });

  it("is ok when no lane reads anything", () => {
    const check = env();
    expect(check.id).toBe("environment");
    expect(check.state).toBe("ok");
  });

  it("warns with the names, when they are nowhere to be found", () => {
    const check = env({ uses: reading("ASC_KEY_ID", "SUPPLY_JSON_KEY") });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/ASC_KEY_ID/);
    expect(check.detail).toMatch(/SUPPLY_JSON_KEY/);
    expect(check.fixIn).toBe("secrets");
    // The sentence someone whose secrets are in a gitignored file needs to read.
    expect(check.fix).toMatch(/gitignored/);
  });

  it("is ok when the vault has them", () => {
    const check = env({
      uses: reading("ASC_KEY_ID"),
      secretKeys: ["ASC_KEY_ID"],
    });
    expect(check.state).toBe("ok");
  });

  // It works — but because of how this server was started, which is not
  // something the project carries with it.
  it("says so when a variable comes from the server's environment rather than the vault", () => {
    const check = env({ uses: reading("ASC_KEY_ID"), serverEnv: ["ASC_KEY_ID"] });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/this server's environment/);
  });

  /**
   * A block writes the file and exports the name itself, for the length of the
   * run. Asking for it would be asking for what was just uploaded.
   */
  it("counts a name a signing block exports", () => {
    const check = env({
      uses: reading("SUPPLY_JSON_KEY"),
      blockNames: ["SUPPLY_JSON_KEY"],
    });
    expect(check.state).toBe("ok");
    // Not "borrowed from this server's environment": it comes from the vault,
    // which is where the block is.
    expect(check.detail).not.toMatch(/this server's own environment/);
  });

  it("still warns about the names no block supplies", () => {
    const check = env({
      uses: reading("SUPPLY_JSON_KEY", "SENTRY_AUTH_TOKEN"),
      blockNames: ["SUPPLY_JSON_KEY"],
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/SENTRY_AUTH_TOKEN/);
    expect(check.detail).not.toMatch(/SUPPLY_JSON_KEY/);
  });

  it("only warns about the ones actually missing", () => {
    const check = env({
      uses: reading("A", "B", "C"),
      secretKeys: ["A"],
      serverEnv: ["B"],
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/\bC\b/);
    expect(check.detail).not.toMatch(/\bA\b/);
  });

  /**
   * The limitation this pairs against. `sentry-cli` reads `SENTRY_AUTH_TOKEN`
   * from the environment; the Fastfile never names it, so no parse will find
   * it. A committed `.env.example` names it, and `required_secrets` is there
   * for whatever neither covers — both arrive as `declared`.
   */
  it("checks a variable that was declared rather than found", () => {
    const check = env({ uses: reading("ASC_KEY_ID"), declared: ["SENTRY_AUTH_TOKEN"] });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/SENTRY_AUTH_TOKEN/);
  });

  it("counts a declared variable as satisfied by the vault like any other", () => {
    const check = env({
      uses: lanes(),
      declared: ["SENTRY_AUTH_TOKEN"],
      secretKeys: ["SENTRY_AUTH_TOKEN"],
    });
    expect(check.state).toBe("ok");
  });

  it("names a variable once when it is both read and declared", () => {
    const check = env({ uses: reading("ASC_KEY_ID"), declared: ["ASC_KEY_ID"] });
    expect(check.detail.match(/ASC_KEY_ID/g)).toHaveLength(1);
  });

  it("is unknown when the lanes could not be read at all", () => {
    const check = env({ uses: unknown("no Ruby on this machine") });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/no Ruby/);
  });

  it("does not claim no lane reads a variable when the reading was partial", () => {
    const check = env({ unread: known({ imports: true, customActions: false }) });
    expect(check.state).toBe("unknown");
  });
});

/**
 * The one check whose failure is silent, and therefore the one worth having.
 * Everything else on this list fails loudly; this one succeeds and ships an
 * artifact the store will refuse.
 */
describe("checkReleaseSigning", () => {
  const facts = (over: Partial<SigningFacts> = {}) =>
    known({ ...NO_SIGNING_FACTS, ...over });

  it("is ok when the release build never takes the debug config", () => {
    const check = checkReleaseSigning({ gradle: facts(), conditionalFilePresent: false });
    expect(check.id).toBe("release-signing");
    expect(check.state).toBe("ok");
  });

  // The situation: key.properties is gitignored, so it is absent from every
  // clone — and the build succeeds anyway, with the debug key.
  it("warns when the fallback is live because the file is not in the clone", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "root" },
      }),
      conditionalFilePresent: false,
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/will not fail/);
    expect(check.detail).toMatch(/key\.properties/);
  });

  it("still says so when the file is there, because it is one deletion away", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "root" },
      }),
      conditionalFilePresent: true,
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/if it goes missing/);
  });

  it("does not guess when the fallback hinges on something it cannot read", () => {
    const check = checkReleaseSigning({
      gradle: facts({ releaseCanUseDebugKey: true, conditionalOn: null }),
      conditionalFilePresent: false,
    });
    expect(check.state).toBe("unknown");
  });

  it("is unknown when there was no build script to read", () => {
    const check = checkReleaseSigning({
      gradle: unknown("no android build.gradle found in the clone"),
      conditionalFilePresent: false,
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/no android build\.gradle/);
  });

  it("asks for a block rather than for a rewritten build script", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "root" },
      }),
      conditionalFilePresent: false,
    });
    expect(check.state).toBe("warn");
    expect(check.fix).toMatch(/keystore block/);
    expect(check.fix).toMatch(/Nothing in the build script changes/);
    // What it used to say: supply the keystore through the environment, and
    // make a missing key an error — a `build.gradle.kts` edit, twice over.
    expect(check.fix).not.toMatch(/through the environment/);
    expect(check.fix).not.toMatch(/an error rather than a fallback/);
  });

  it("says what it will write, where, and under which names", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "root" },
      }),
      conditionalFilePresent: false,
      keystore: {
        propertyNames: ["storeFile", "storePassword", "keyPassword", "keyAlias"],
        propertiesPath: null,
      },
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/Laneyard writes key\.properties in the Gradle root directory/);
    for (const key of ["storeFile", "storePassword", "keyPassword", "keyAlias"]) {
      expect(check.detail).toContain(key);
    }
    // The assumption is stated rather than hidden: the names came from a
    // convention, not from the build script.
    expect(check.detail).toMatch(/with the keys/);
  });

  it("names the keys the block was given, not the ones it assumed", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "signing.properties", scope: "module" },
      }),
      conditionalFilePresent: false,
      keystore: { propertyNames: ["store", "storePw", "keyPw", "alias"], propertiesPath: null },
    });
    expect(check.detail).toMatch(/store, storePw, keyPw and alias/);
    expect(check.detail).not.toMatch(/storeFile/);
  });

  it("uses the path the block names when there is one", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "unknown" },
      }),
      conditionalFilePresent: false,
      keystore: {
        propertyNames: ["storeFile", "storePassword", "keyPassword", "keyAlias"],
        propertiesPath: "android/key.properties",
      },
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/android\/key\.properties/);
  });

  // The way this check can be wrong while every part of it is right: the
  // configured path wins at run time, so one off by a directory is written,
  // found by nobody, and the release build signs with the debug key.
  it("warns when the configured path is not where the build reads", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "root" },
      }),
      conditionalFilePresent: false,
      conditionalFileAt: "android/key.properties",
      keystore: {
        propertyNames: ["storeFile", "storePassword", "keyPassword", "keyAlias"],
        propertiesPath: "key.properties",
      },
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/android\/key\.properties/);
    expect(check.detail).toMatch(/debug key/);
    expect(check.fix).toMatch(/android\/key\.properties/);
  });

  it("says nothing when the two paths are the same file typed twice", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "root" },
      }),
      conditionalFilePresent: false,
      conditionalFileAt: "android/key.properties",
      keystore: {
        propertyNames: ["storeFile", "storePassword", "keyPassword", "keyAlias"],
        propertiesPath: "./android/key.properties",
      },
    });
    expect(check.state).toBe("ok");
  });

  // The parser can be wrong about the directory too, and a correct path
  // overruled by a bad reading would be a build that cannot run at all.
  it("does not second-guess the configured path when nothing resolved a directory", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "unknown" },
      }),
      conditionalFilePresent: false,
      conditionalFileAt: null,
      keystore: {
        propertyNames: ["storeFile", "storePassword", "keyPassword", "keyAlias"],
        propertiesPath: "config/key.properties",
      },
    });
    expect(check.state).toBe("ok");
  });

  it("promises nothing when nobody can say which directory the file goes in", () => {
    // The runner declines to write in that case — writing into the likelier of
    // two directories would leave the build signing with the debug key beside a
    // file that looked like the answer. A check that promised a file here would
    // be reassuring and wrong.
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "unknown" },
      }),
      conditionalFilePresent: false,
      keystore: {
        propertyNames: ["storeFile", "storePassword", "keyPassword", "keyAlias"],
        propertiesPath: null,
      },
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/without saying which directory/);
    expect(check.fix).toMatch(/properties file path on the keystore block/);
    expect(check.fixIn).toBe("signing");
  });

  it("leaves the project's own properties file alone, and says so", () => {
    const check = checkReleaseSigning({
      gradle: facts({
        releaseCanUseDebugKey: true,
        conditionalOn: { name: "key.properties", scope: "root" },
      }),
      conditionalFilePresent: true,
      keystore: {
        propertyNames: ["storeFile", "storePassword", "keyPassword", "keyAlias"],
        propertiesPath: null,
      },
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/so the release key is used/);
  });
});

/**
 * The constraint the whole product rests on, asserted across the table rather
 * than sentence by sentence: **Laneyard adapts to the project, and never the
 * other way round.** A repository that builds today keeps building unedited.
 *
 * It is written as a sweep because it is the kind of rule that gets honoured
 * once, in the change that introduced it, and lost quietly two features later —
 * a sentence added to one branch of one check, which nobody reads again.
 *
 * The vocabulary below is what "edit your own project" sounded like in the
 * three messages this replaced: reading a secret in the lane with `ENV[…]`,
 * passing `storePassword:` to gradle, supplying the keystore through the
 * environment, and making a missing key an error instead of a fallback. Any of
 * them reappearing on a credential line is the regression.
 */
describe("never tells the user to edit their own project", () => {
  const HOMEWORK = [
    /ENV\[/,
    /ENV\.fetch/,
    /storePassword:/,
    /through the environment/i,
    /an error rather than a fallback/i,
    /\b(edit|rewrite|change|adapt|modify)\b[^.]*\b(Fastfile|build\.gradle|build script|lane|lanes|project|repository)\b/i,
    /\badd\b[^.]*\bto (your|the) (Fastfile|build\.gradle|build script|lane)\b/i,
  ];

  /** Every credential line, over every arrangement that produces one. */
  const everyCredentialCheck = (): Check[] => {
    const withKey = lanes({
      lane: "release",
      actions: [
        { name: "upload_to_testflight", args: {} },
        { name: "upload_to_play_store", args: {} },
        { name: "gradle", args: { storeFile: "k.jks" } },
      ],
    });
    const named = lanes({
      lane: "release",
      actions: [
        { name: "app_store_connect_api_key", args: { key_filepath: "AuthKey.p8" } },
        { name: "upload_to_play_store", args: { json_key: "play.json" } },
      ],
    });
    const buildOnly = lanes({ lane: "build", actions: [{ name: "build_app", args: {} }] });
    const blindly = known({ imports: true, customActions: true });
    const appfiles = [
      known(NO_APPFILE),
      known({ ...NO_APPFILE, appleId: { kind: "literal" as const, value: "me@x.com" } }),
      known({ ...NO_APPFILE, jsonKeyFile: { kind: "literal" as const, value: "play.json" } }),
    ];

    const checks: Check[] = [];
    for (const uses of [withKey, named, buildOnly, unknown<LaneUses[]>("no Ruby")]) {
      for (const unread of [known(READ_EVERYTHING), blindly]) {
        for (const secretKeys of [[], ["FASTLANE_SESSION"], ["APP_STORE_CONNECT_API_KEY_P8"]]) {
          for (const appfile of appfiles) {
            checks.push(
              checkAppStoreConnect({
                secretKeys,
                uses,
                keyFilesInRepo: known<string[]>(["AuthKey.p8"]),
                appfile,
                unread,
                blocks: [],
              }),
              checkAndroidKeystore(uses, secretKeys, unread, []),
              checkPlayStore(uses, secretKeys, appfile, unread, []),
            );
          }
        }
      }
    }

    for (const scope of ["root", "module", "unknown"] as const) {
      for (const conditionalFilePresent of [true, false]) {
        for (const keystore of [
          null,
          { propertyNames: ["storeFile", "storePassword", "keyPassword", "keyAlias"], propertiesPath: null },
        ]) {
          checks.push(
            checkReleaseSigning({
              gradle: known({
                releaseCanUseDebugKey: true,
                conditionalOn: { name: "key.properties", scope },
              }),
              conditionalFilePresent,
              keystore,
            }),
          );
        }
      }
    }
    return checks;
  };

  it("recommends a block, never a commit", () => {
    const checks = everyCredentialCheck();
    // A sweep that swept nothing would pass in silence.
    expect(checks.length).toBeGreaterThan(50);
    expect(checks.filter((c) => c.fix !== undefined).length).toBeGreaterThan(10);

    for (const check of checks) {
      for (const pattern of HOMEWORK) {
        expect(`${check.id}: ${check.fix ?? ""}`).not.toMatch(pattern);
        expect(`${check.id}: ${check.detail}`).not.toMatch(pattern);
      }
    }
  });

  it("catches the phrasing that was there before, so the sweep is known to work", () => {
    // The three messages this replaced, verbatim. If none of them trips the
    // patterns above, the test above proves nothing.
    const gone = [
      'Store the keystore passphrase as `ANDROID_KEYSTORE_PASSWORD` from the secrets tab, and read it in the lane with `storePassword: ENV["ANDROID_KEYSTORE_PASSWORD"]`.',
      "key.properties is gitignored, so it never reaches a clone. Supply the keystore through the environment instead, and make a release build without one an error rather than a fallback.",
      "Add `app_store_connect_api_key` to your Fastfile.",
    ];
    for (const sentence of gone) {
      expect(HOMEWORK.some((pattern) => pattern.test(sentence))).toBe(true);
    }
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
    appfile: known(NO_APPFILE),
    keyFilesInRepo: known<string[]>([]),
    unread: known(READ_EVERYTHING),
    serverEnv: [],
    declaredSecrets: [],
    androidSigning: known(NO_SIGNING_FACTS),
    signingFilePresent: false,
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
    expect(note.detail).toMatch(/no Xcode project and no Gradle build/);
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

  it("hands the blocks to every check that has a use for them", async () => {
    // The wiring, asserted at the table rather than check by check: a block
    // stored once must answer on all three lines it applies to.
    const sections = await runChecklist(
      input({
        platforms: known<Platform[]>(["ios", "android"]),
        secretKeys: [],
        uses: lanes({
          lane: "release",
          actions: [
            { name: "upload_to_testflight", args: {} },
            { name: "upload_to_play_store", args: {} },
            { name: "gradle", args: { storeFile: "k.jks" } },
          ],
        }),
        blocks: ["apple_asc", "android_keystore", "play_service_account"],
      }),
    );
    const checks = sections.flatMap((s) => s.checks);
    for (const id of ["app-store-connect", "android-keystore", "play-store"]) {
      expect(checks.find((c) => c.id === id)!.state).toBe("ok");
    }
  });

  it("shows a project that ships nowhere a screen with nothing to do", async () => {
    // A lane that builds and stops, on both platforms, with an empty vault.
    // Not one line asks for a credential, because not one line needs one.
    const sections = await runChecklist(
      input({
        platforms: known<Platform[]>(["ios", "android"]),
        secretKeys: [],
        uses: lanes({ lane: "build", actions: [{ name: "build_app", args: {} }] }),
        blocks: [],
      }),
    );
    const credentials = sections
      .flatMap((s) => s.checks)
      .filter((c) => ["app-store-connect", "play-store"].includes(c.id));
    expect(credentials).toHaveLength(2);
    expect(credentials.every((c) => c.state === "ok")).toBe(true);
  });

  it("gives every check a title", async () => {
    const sections = await runChecklist(input({ platforms: known<Platform[]>(["ios", "android"]) }));
    expect(sections.flatMap((s) => s.checks).every((c) => c.title.length > 0)).toBe(true);
  });
});

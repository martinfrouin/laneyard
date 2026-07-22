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
  /** Only the vault differs in most of these; the other three places say nothing. */
  const asc = (secretKeys: string[], over: Partial<AppStoreConnectInput> = {}) =>
    checkAppStoreConnect({
      secretKeys,
      uses: lanes(),
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
    expect(check.fixIn).toBe("secrets");
  });

  it("prefers the API key when both are stored", () => {
    const check = asc(["FASTLANE_SESSION", "APP_STORE_CONNECT_API_KEY_KEY"]);
    expect(check.state).toBe("ok");
  });

  it("warns when nothing anywhere holds a key, and points at the secrets tab", () => {
    const check = asc([]);
    expect(check.state).toBe("warn");
    expect(check.fixIn).toBe("secrets");
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
    expect(check.fixIn).toBe("secrets");
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
    expect(check.detail).toMatch(/environment variable/);
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
    expect(check.detail).toMatch(/out of sight/);
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
    expect(check.fix).toMatch(/does not travel/);
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
    expect(check.detail).toMatch(/this server's own environment/);
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
      gradle: facts({ releaseCanUseDebugKey: true, conditionalOn: "key.properties" }),
      conditionalFilePresent: false,
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/will not fail/);
    expect(check.detail).toMatch(/key\.properties/);
  });

  it("still says so when the file is there, because it is one deletion away", () => {
    const check = checkReleaseSigning({
      gradle: facts({ releaseCanUseDebugKey: true, conditionalOn: "key.properties" }),
      conditionalFilePresent: true,
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/if it ever goes missing/);
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

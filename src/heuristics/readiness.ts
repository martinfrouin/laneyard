import type { PropertiesFile, SigningFacts } from "./android-signing.js";
import type { AppfileFacts } from "./appfile.js";
import { argsGiven, findBlockingActions } from "./blocking-actions.js";
import type { UsedAction } from "./blocking-actions.js";
import type { Platform } from "./platforms.js";

/**
 * The readiness checklist: what stands between a project and a build that runs
 * while nobody watches.
 *
 * Named knowledge of fastlane — `match`, `MATCH_PASSWORD`, App Store Connect —
 * hence its place in this module, and the boundary that comes with it: nothing
 * here blocks a run, hides a lane or touches a Fastfile. A check produces a
 * sentence; the user decides what to do about it.
 *
 * Two rules hold everywhere below:
 *
 * - **Nothing throws.** A check that cannot determine its answer returns
 *   `unknown` with the reason. A checklist that fails to load is a checklist
 *   people learn to ignore, and then the one time it was right nobody reads it.
 * - **No check reaches for a database, a config store or a shell.** Everything
 *   a check needs arrives as an argument, which is what makes the whole table
 *   testable with plain values.
 *
 * The list is in three sections. The shared one always applies; the iOS and
 * Android ones only when the project builds for that platform. An Android
 * project told off for having no App Store Connect key is worse than unhelpful:
 * one irrelevant warning teaches someone to ignore the whole screen, and then
 * the one line that mattered goes unread with the rest.
 */

export type CheckState = "ok" | "warn" | "unknown";

export interface Check {
  id: string;
  title: string;
  state: CheckState;
  detail: string;
  /** What to do about it, as a sentence. Never an action Laneyard takes itself. */
  fix?: string;
  /** Set only when the fix genuinely is one action the interface can lead to. */
  fixIn?: "secrets";
}

/**
 * A fact the caller either established or could not.
 *
 * The `reason` half is why the checklist can say "could not tell" in the same
 * words the caller would have used, instead of inventing a verdict from
 * missing data.
 */
export type Known<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface LaneUses {
  lane: string;
  actions: UsedAction[];
  /** Environment variables the lane reads, by name. Absent on an older cache. */
  env?: string[];
}

/**
 * Why reading the Fastfile might not have been the whole story.
 *
 * The parser follows a lane into the methods this Fastfile defines, which is
 * how a well-factored Fastfile is read at all. Two things stay out of reach,
 * and both are ordinary: `import`/`import_from_git` bring in lanes written in
 * another file, and `fastlane/actions/` holds actions whose names mean nothing
 * to a parser that has only seen the Fastfile.
 *
 * This exists because of what a check used to do with that. Finding no upload
 * action, it answered "no lane uploads to the Play Store" — a tick, stated
 * plainly, for a project that uploads on every run. A warning that is wrong
 * gets argued with; a tick that is wrong gets believed. So a check that would
 * conclude something from *absence* asks this first, and answers "could not
 * tell" when the absence might be its own blindness.
 */
export interface Unread {
  /** The Fastfile pulls lanes in from elsewhere. */
  imports: boolean;
  /** The project defines its own actions, under names this parse cannot know. */
  customActions: boolean;
}

export const READ_EVERYTHING: Unread = { imports: false, customActions: false };

/** The sentence, once, so four checks cannot drift apart on how they say it. */
function unreadReason(unread: Known<Unread>): string | null {
  if (!unread.ok) return null;
  const { imports, customActions } = unread.value;
  if (imports && customActions) {
    return "this Fastfile imports lanes from elsewhere and the project defines its own actions";
  }
  if (imports) return "this Fastfile imports lanes from elsewhere";
  if (customActions) return "the project defines its own actions in fastlane/actions";
  return null;
}

/** What each check body produces; `id` and `title` come from the table. */
interface Outcome {
  state: CheckState;
  detail: string;
  fix?: string;
  fixIn?: "secrets";
}

const ok = (detail: string): Outcome => ({ state: "ok", detail });
const warn = (detail: string, fix?: string, fixIn?: "secrets"): Outcome => ({
  state: "warn",
  detail,
  ...(fix === undefined ? {} : { fix }),
  ...(fixIn === undefined ? {} : { fixIn }),
});
const undetermined = (detail: string, fix?: string): Outcome => ({
  state: "unknown",
  detail,
  ...(fix === undefined ? {} : { fix }),
});

/** A rejection is not always an `Error`; a checklist saying "undefined" is worse than useless. */
const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Identity and wording live here so a check and its fallback cannot drift apart. */
const META = {
  repository: { id: "repository", title: "repository reachable without a password" },
  dependencies: { id: "dependencies", title: "dependencies installable" },
  appStoreConnect: { id: "app-store-connect", title: "App Store Connect authentication" },
  match: { id: "match", title: "match usable without intervention" },
  blockingActions: { id: "blocking-actions", title: "no action known to stop and ask" },
  androidKeystore: { id: "android-keystore", title: "keystore reachable without a prompt" },
  playStore: { id: "play-store", title: "Play Store service account" },
  platforms: { id: "platforms", title: "what this project builds for" },
  environment: { id: "environment", title: "the variables the lanes read" },
  releaseSigning: { id: "release-signing", title: "release signed with the release key" },
} as const;

/**
 * Does the remote answer without asking anyone for credentials?
 *
 * The probe is injected — `Workspace` already knows how to run git with
 * `GIT_TERMINAL_PROMPT=0` and how to keep the repository URL, which may carry a
 * token, out of its own error messages. Redacting is the probe's job, not this
 * check's: whatever it rejects with is repeated verbatim.
 */
export async function checkRepository(probe: () => Promise<unknown>): Promise<Check> {
  try {
    await probe();
    return { ...META.repository, ...ok("the remote answers without asking for credentials.") };
  } catch (cause) {
    return {
      ...META.repository,
      ...warn(
        reasonOf(cause),
        "Give the project a key it can use without a passphrase — " +
          "`git_auth: {kind: ssh_key, ref: /path/to/key}` in config.yml — or a URL that needs no password. " +
          "A run that meets a credentials prompt does not fail: it waits.",
      ),
    };
  }
}

export interface DependenciesInput {
  /** The workspace, or why it could not be inspected — an absent clone, mostly. */
  workspace: Known<{ hasGemfile: boolean }>;
  /** `bundle check` in the workspace. Rejects with what bundler said. */
  bundleCheck: () => Promise<unknown>;
  /** The path of a `fastlane` on the PATH, or null. */
  findFastlane: () => Promise<string | null>;
}

export async function checkDependencies(input: DependenciesInput): Promise<Check> {
  const { workspace } = input;
  if (!workspace.ok) {
    return { ...META.dependencies, ...undetermined(`could not read the workspace: ${workspace.reason}`) };
  }

  if (workspace.value.hasGemfile) {
    try {
      await input.bundleCheck();
      return { ...META.dependencies, ...ok("the Gemfile's bundle is installed.") };
    } catch (cause) {
      return {
        ...META.dependencies,
        ...warn(reasonOf(cause), "Run `bundle install` in the project's workspace."),
      };
    }
  }

  let fastlane: string | null;
  try {
    fastlane = await input.findFastlane();
  } catch (cause) {
    return { ...META.dependencies, ...undetermined(`could not look for fastlane: ${reasonOf(cause)}`) };
  }

  if (fastlane !== null) {
    // Not a failure, but a fact worth stating: a system fastlane can be
    // upgraded underneath a project that was working yesterday.
    return {
      ...META.dependencies,
      ...ok(`no Gemfile — runs use ${fastlane}, whose version nothing pins.`),
    };
  }

  return {
    ...META.dependencies,
    ...warn(
      "no Gemfile, and no fastlane on the PATH: a run has nothing to execute.",
      'Add a Gemfile with `gem "fastlane"` and run `bundle install`, or install fastlane system-wide.',
    ),
  };
}

/** Any suffix: the key is split across several variables, and their names vary by lane. */
const API_KEY = /^APP_STORE_CONNECT_API_KEY/;

const STORE_API_KEY =
  "Store an App Store Connect API key — `APP_STORE_CONNECT_API_KEY_ID`, " +
  "`APP_STORE_CONNECT_API_KEY_ISSUER_ID` and the `.p8` contents — from the secrets tab. " +
  "An API key does not expire on its own.";

/** The action whose whole job is to load a `.p8`, under both of its names. */
const ASC_KEY_ACTIONS = new Set(["app_store_connect_api_key", "asc_api_key"]);

/**
 * Arguments that name the key somewhere other than the vault.
 *
 * `key_filepath` and `api_key_path` are paths to a `.p8`; `key_content` and
 * `api_key` are the thing itself, or a hash built earlier in the lane.
 */
const ASC_KEY_ARGS = ["key_filepath", "key_content", "api_key_path", "api_key", "key_id"];

export interface AppStoreConnectInput {
  secretKeys: string[];
  uses: Known<LaneUses[]>;
  /** `.p8` files the repository carries, or why the repository could not be listed. */
  keyFilesInRepo: Known<string[]>;
  appfile: Known<AppfileFacts>;
  unread?: Known<Unread>;
}

/**
 * Is there an App Store Connect credential, wherever it lives?
 *
 * Four places, and the vault is only the first. A project that configured
 * fastlane years before it met Laneyard has its key in the Fastfile or beside
 * it, and telling that project it has "no App Store Connect credential" is
 * false — the run works. So the Fastfile, the repository and the Appfile are
 * all read before anything is claimed.
 *
 * Only the vault earns a tick. Everything else earns `unknown`, and the reason
 * is the same every time: a path in a Fastfile, or a `.p8` in a repository, says
 * a credential was arranged — it does not say the file is on *this* machine,
 * with the passphrase and permissions a run needs. A green tick that means "it
 * looks arranged" is the tick nobody can trust afterwards.
 */
export function checkAppStoreConnect(input: AppStoreConnectInput): Check {
  const { secretKeys, uses, keyFilesInRepo, appfile } = input;

  if (secretKeys.some((key) => API_KEY.test(key))) {
    return { ...META.appStoreConnect, ...ok("an App Store Connect API key is in the vault.") };
  }

  // Named in a lane: the commonest way a pre-existing project holds its key,
  // and the one the vault-only check used to report as nothing at all.
  const inLanes = uses.ok
    ? uses.value.filter((lane) =>
        lane.actions.some(
          (a) =>
            ASC_KEY_ACTIONS.has(a.name) ||
            ASC_KEY_ARGS.some((arg) => argsGiven(a).includes(arg)),
        ),
      )
    : [];

  if (inLanes.length > 0) {
    return {
      ...META.appStoreConnect,
      ...undetermined(
        `${nameList(inLanes.map((l) => l.lane))} supplies its own API key: whether the \`.p8\` it ` +
          "names is on this machine is not something a Fastfile says.",
        STORE_API_KEY,
      ),
    };
  }

  const p8 = keyFilesInRepo.ok ? keyFilesInRepo.value : [];
  if (p8.length > 0) {
    return {
      ...META.appStoreConnect,
      ...undetermined(
        `the repository carries ${nameList(p8)}: a key is arranged, but nothing here says a lane ` +
          "loads it, or that it is the one App Store Connect expects.",
        STORE_API_KEY,
      ),
    };
  }

  if (secretKeys.includes("FASTLANE_SESSION")) {
    return {
      ...META.appStoreConnect,
      ...warn(
        "only a FASTLANE_SESSION: Apple sessions expire, and the run that finds it expired " +
          "stops and asks for a verification code.",
        STORE_API_KEY,
        "secrets",
      ),
    };
  }

  // An Apple ID in the Appfile is not a credential — it is the thing that makes
  // a run stop and ask for a verification code — but saying so is more use than
  // "no credential", which reads as though the Appfile had not been looked at.
  if (appfile.ok && appfile.value.appleId.kind !== "absent") {
    return {
      ...META.appStoreConnect,
      ...warn(
        "the Appfile names an Apple ID and nothing else: a lane that uploads signs in as that " +
          "account, and two-factor authentication stops the run to ask for a code.",
        STORE_API_KEY,
        "secrets",
      ),
    };
  }

  // This one is a warning rather than a tick, so being wrong costs less — but
  // "in the lanes" is a claim about lanes that were read, and saying it about
  // lanes that could not be is still saying something untrue.
  const blind = unreadReason(input.unread ?? { ok: true, value: READ_EVERYTHING });
  if (blind) {
    return {
      ...META.appStoreConnect,
      ...undetermined(
        `no App Store Connect credential in the vault or in the repository, and none seen in the ` +
          `lanes — but ${blind}.`,
        STORE_API_KEY,
      ),
    };
  }

  return {
    ...META.appStoreConnect,
    ...warn(
      "no App Store Connect credential in the vault, in the lanes, or in the repository: " +
        "a lane that uploads will ask for an Apple ID.",
      STORE_API_KEY,
      "secrets",
    ),
  };
}

/** The two names for the same action. `match` is the older one, still the common one. */
const MATCH_ACTIONS = new Set(["match", "sync_code_signing"]);

/** "beta and release" reads better than a list of one, and than a trailing comma. */
function nameList(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

export function checkMatch(uses: Known<LaneUses[]>, secretKeys: string[]): Check {
  if (!uses.ok) {
    return { ...META.match, ...undetermined(`could not read the lanes: ${uses.reason}`) };
  }

  const calls = uses.value.flatMap((lane) =>
    lane.actions.filter((a) => MATCH_ACTIONS.has(a.name)).map((action) => ({ lane: lane.lane, action })),
  );

  if (calls.length === 0) {
    return { ...META.match, ...ok("no lane uses match.") };
  }

  if (!secretKeys.includes("MATCH_PASSWORD")) {
    return {
      ...META.match,
      ...warn(
        `${nameList(calls.map((c) => c.lane))} calls match, but MATCH_PASSWORD is not in the vault: ` +
          "match asks for the passphrase and waits for it.",
        "Store `MATCH_PASSWORD` from the secrets tab.",
        "secrets",
      ),
    };
  }

  const writable = calls.filter((c) => c.action.args["readonly"] === false);
  if (writable.length > 0) {
    return {
      ...META.match,
      ...warn(
        `${nameList(writable.map((c) => c.lane))} calls match with \`readonly: false\`: it may try to ` +
          "create certificates, which needs an Apple account interactively.",
        "Pass `readonly: true` so it only fetches what already exists.",
      ),
    };
  }

  // `match(readonly: ENV["RO"])` arrives with no `readonly` at all: the sidecar
  // reports literal arguments and refuses to guess at the rest. Calling that
  // green would be the checklist claiming to know something it does not.
  const undecided = calls.filter((c) => !("readonly" in c.action.args));
  if (undecided.length > 0) {
    return {
      ...META.match,
      ...undetermined(
        `MATCH_PASSWORD is stored, but \`readonly\` is not a literal in ` +
          `${nameList(undecided.map((c) => c.lane))}: Laneyard reads literal arguments only, and will not guess.`,
        "Pass `readonly: true` in the call itself if that is what you mean.",
      ),
    };
  }

  return { ...META.match, ...ok("MATCH_PASSWORD is stored, and every match call is readonly.") };
}

export function checkBlockingActions(
  uses: Known<LaneUses[]>,
  unread: Known<Unread> = { ok: true, value: READ_EVERYTHING },
): Check {
  if (!uses.ok) {
    return { ...META.blockingActions, ...undetermined(`could not read the lanes: ${uses.reason}`) };
  }

  const findings = uses.value.flatMap((lane) =>
    findBlockingActions(lane.actions).map((finding) => ({ lane: lane.lane, finding })),
  );

  if (findings.length === 0) {
    const blind = unreadReason(unread);
    if (blind) {
      return {
        ...META.blockingActions,
        ...undetermined(
          `no lane seen to call an action known to stop and ask — but ${blind}, so a lane that ` +
            "waits could be out of sight from here.",
        ),
      };
    }
    return { ...META.blockingActions, ...ok("no lane calls an action known to stop and ask.") };
  }

  return {
    ...META.blockingActions,
    ...warn(
      findings.map((f) => `${f.lane} calls ${f.finding.action}: it ${f.finding.because}`).join("; ") + ".",
      // The same fix stated twice reads as two different fixes.
      [...new Set(findings.map((f) => f.finding.fix))].join(" "),
    ),
  };
}

/** `build_android_app` is the newer name for the same action. */
const GRADLE_ACTIONS = new Set(["gradle", "build_android_app"]);

/**
 * The arguments that say a lane hands gradle a keystore of its own.
 *
 * Read literally, like everything else here. `gradle(storePassword: ENV["PW"])`
 * arrives with no `storePassword` at all — the sidecar drops what it cannot
 * read — and this check says so rather than inventing a verdict.
 */
const KEYSTORE_ARGS = ["storeFile", "storePassword"];

/** `ANDROID_KEYSTORE_PASSWORD`, `KEYSTORE_PASSWORD`, `STORE_PASSWORD`. */
const KEYSTORE_PASSWORD = /(^|_)(KEYSTORE|STORE)_PASSWORD$/;

const STORE_KEYSTORE_PASSWORD =
  "Store the keystore passphrase as `ANDROID_KEYSTORE_PASSWORD` from the secrets tab, " +
  "and read it in the lane with `storePassword: ENV[\"ANDROID_KEYSTORE_PASSWORD\"]`.";

export function checkAndroidKeystore(
  uses: Known<LaneUses[]>,
  secretKeys: string[],
  unread: Known<Unread> = { ok: true, value: READ_EVERYTHING },
): Check {
  if (!uses.ok) {
    return { ...META.androidKeystore, ...undetermined(`could not read the lanes: ${uses.reason}`) };
  }

  const calls = uses.value.flatMap((lane) =>
    lane.actions.filter((a) => GRADLE_ACTIONS.has(a.name)).map((action) => ({ lane: lane.lane, action })),
  );

  if (calls.length === 0) {
    // This check only runs in the Android section, so reaching here means the
    // project builds for Android and no lane was seen calling gradle. That is
    // not "nothing needs a keystore" — it is a build driven by something else.
    // `flutter build appbundle` and `react-native build-android` both run
    // gradle underneath, and the signing configuration then lives in
    // `build.gradle` or `key.properties`, where no reading of a Fastfile
    // reaches it. Ticking that was the same mistake as the Play Store one: a
    // confident green for a question nobody answered.
    const blind = unreadReason(unread);
    return {
      ...META.androidKeystore,
      ...undetermined(
        "no lane seen handing gradle a keystore" +
          (blind ? ` — and ${blind}` : "") +
          ". This project builds for Android, so signing is configured somewhere a Fastfile does " +
          "not show: `build.gradle`, `key.properties`, or a build driven through flutter or " +
          "react-native.",
      ),
    };
  }

  // `given`, not `args`, for the same reason as the two credential checks:
  // `storePassword: ENV["KS_PASS"]` is a keystore that needs unlocking just as
  // much as a literal one, and it leaves no literal behind.
  const signing = calls.filter((c) =>
    KEYSTORE_ARGS.some((arg) => argsGiven(c.action).includes(arg)),
  );
  if (signing.length === 0) {
    // Deliberately a statement about what was read, not about the build: a
    // keystore configured in `build.gradle` or through the environment is
    // invisible from here, and claiming it is absent would be a guess.
    return {
      ...META.androidKeystore,
      ...ok("no lane passes `storeFile` or `storePassword` to gradle: nothing here needs unlocking."),
    };
  }

  const withoutPassphrase = signing.filter((c) => !("storePassword" in c.action.args));
  if (withoutPassphrase.length === 0) {
    return {
      ...META.androidKeystore,
      ...ok(
        `${nameList(signing.map((c) => c.lane))} passes \`storePassword\` in the call itself: ` +
          "gradle has what it needs.",
      ),
    };
  }

  if (secretKeys.some((key) => KEYSTORE_PASSWORD.test(key))) {
    return { ...META.androidKeystore, ...ok("a keystore passphrase is in the vault.") };
  }

  return {
    ...META.androidKeystore,
    ...warn(
      `${nameList(withoutPassphrase.map((c) => c.lane))} hands gradle a keystore, but no keystore ` +
        "passphrase is in the vault: gradle asks for it and waits.",
      STORE_KEYSTORE_PASSWORD,
      "secrets",
    ),
  };
}

/** The two names for the same action. `supply` is the older one. */
const PLAY_UPLOAD_ACTIONS = new Set(["upload_to_play_store", "supply"]);

/** `SUPPLY_JSON_KEY` and `SUPPLY_JSON_KEY_DATA`, the names fastlane itself reads. */
const PLAY_JSON_KEY = /^SUPPLY_JSON_KEY/;

/** The same credential, named in the call instead of in the vault. */
const PLAY_KEY_ARGS = ["json_key", "json_key_data"];

/** Named once: three outcomes of the environment check point at the same thing. */
const DECLARE_SECRETS =
  "A variable read by a tool the lane shells out to — `sentry-cli` and its " +
  "`SENTRY_AUTH_TOKEN`, say — is not something a Fastfile mentions. List those under " +
  "`required_secrets` in laneyard.yml and they are checked like the rest.";

const STORE_PLAY_KEY =
  "Store the service account JSON as `SUPPLY_JSON_KEY_DATA` from the secrets tab. " +
  "A service account does not expire on its own.";

export function checkPlayStore(
  uses: Known<LaneUses[]>,
  secretKeys: string[],
  appfile: Known<AppfileFacts>,
  unread: Known<Unread> = { ok: true, value: READ_EVERYTHING },
): Check {
  if (!uses.ok) {
    return { ...META.playStore, ...undetermined(`could not read the lanes: ${uses.reason}`) };
  }

  const calls = uses.value.flatMap((lane) =>
    lane.actions
      .filter((a) => PLAY_UPLOAD_ACTIONS.has(a.name))
      .map((action) => ({ lane: lane.lane, action })),
  );

  if (calls.length === 0) {
    // The one conclusion drawn purely from absence, and the one that was wrong
    // for every project whose upload sits behind an import or a custom action.
    const blind = unreadReason(unread);
    if (blind) {
      return {
        ...META.playStore,
        ...undetermined(
          `no lane seen to upload to the Play Store — but ${blind}, so this is not the same ` +
            "as no lane uploading.",
          STORE_PLAY_KEY,
        ),
      };
    }
    return { ...META.playStore, ...ok("no lane uploads to the Play Store.") };
  }

  if (secretKeys.some((key) => PLAY_JSON_KEY.test(key))) {
    return { ...META.playStore, ...ok("a Play Store service account is in the vault.") };
  }

  // Named in the call, whether or not the value could be read. `json_key:
  // ENV.fetch("…")` is a credential the lane supplies itself just as much as a
  // literal path is — and reading only literals is what used to make this check
  // and the App Store Connect one disagree about the same situation.
  const named = calls.filter((c) =>
    PLAY_KEY_ARGS.some((arg) => argsGiven(c.action).includes(arg)),
  );
  if (named.length > 0) {
    // A path in a Fastfile says nothing about whether that file exists on this
    // machine. Neither a tick nor a warning would be honest.
    return {
      ...META.playStore,
      ...undetermined(
        `${nameList(named.map((c) => c.lane))} supplies its own service account: whether the file ` +
          "it names is on this machine is not something a Fastfile says.",
        STORE_PLAY_KEY,
      ),
    };
  }

  // The Appfile, which is where a project that predates Laneyard almost always
  // keeps this — and which the check used to be blind to, so a project with a
  // working service account was told it had none.
  if (appfile.ok) {
    const { jsonKeyFile, jsonKeyData } = appfile.value;
    if (jsonKeyData.kind !== "absent") {
      return {
        ...META.playStore,
        ...undetermined(
          "the Appfile sets `json_key_data`: the credential travels with the repository, and " +
            "whether it is still valid is not something a file says.",
          STORE_PLAY_KEY,
        ),
      };
    }
    if (jsonKeyFile.kind === "literal") {
      return {
        ...META.playStore,
        ...undetermined(
          `the Appfile points \`json_key_file\` at ${jsonKeyFile.value}: whether that file is on ` +
            "this machine is not something an Appfile says.",
          STORE_PLAY_KEY,
        ),
      };
    }
    if (jsonKeyFile.kind === "computed") {
      return {
        ...META.playStore,
        ...undetermined(
          "the Appfile sets `json_key_file` to something it computes — an environment variable, " +
            "most likely — which a run only resolves once it is running.",
          STORE_PLAY_KEY,
        ),
      };
    }
  }

  return {
    ...META.playStore,
    ...warn(
      `${nameList(calls.map((c) => c.lane))} uploads to the Play Store, but no service account is in ` +
        "the vault: supply stops and asks which credentials to use.",
      STORE_PLAY_KEY,
      "secrets",
    ),
  };
}

/**
 * The line a project with no platform gets instead of half a checklist.
 *
 * It is not a check — nothing was examined — and it is not a warning either.
 * It says what is missing and where to write it down, and then the shared
 * checks above it still stand on their own.
 */
function platformNote(platforms: Known<Platform[]>): Check {
  return {
    ...META.platforms,
    ...undetermined(
      platforms.ok
        ? "no platform detected: no Xcode project and no Gradle build in the repository, " +
            "and laneyard.yml names none. Only the checks above apply."
        : `could not tell: ${platforms.reason}. Only the checks above apply.`,
      "Add `platforms: [ios]`, `[android]` or both to laneyard.yml in the repository, " +
        "and the checks for that platform appear here.",
    ),
  };
}

export interface ReleaseSigningInput {
  /** The android build script, or why it could not be read. */
  gradle: Known<SigningFacts>;
  /** Whether the properties file it is conditional on is present in the clone. */
  conditionalFilePresent: boolean;
}

/**
 * Where the build resolves the properties file, as a clause a sentence can take.
 *
 * A directory rather than a path: `android/` for one project and the repository
 * root for another, and the parser deliberately reports the scope Gradle uses
 * rather than a path it would have had to invent. An unresolved scope adds
 * nothing to the sentence — naming the wrong directory sends someone to look in
 * a place the build never reads, which is worse than leaving them to look.
 */
function where(file: PropertiesFile): string {
  if (file.scope === "root") return " in the Gradle root directory";
  if (file.scope === "module") return " in the app module directory";
  return "";
}

/**
 * Will a release build actually be signed with the release key?
 *
 * The one check here whose failure is silent. Everything else fails loudly — a
 * run stops, a credential is missing, a lane waits. This one *succeeds*: the
 * build finishes, produces an artifact signed with the debug key, and the error
 * arrives from the store minutes later saying nothing about signing.
 *
 * The pattern is in the Flutter documentation, so it is everywhere: sign with
 * the release config when `key.properties` exists, and with the debug config
 * when it does not. The same documentation gitignores `key.properties` — so it
 * is absent from every clone, including the one a build server works from.
 */
export function checkReleaseSigning(input: ReleaseSigningInput): Check {
  const { gradle, conditionalFilePresent } = input;

  if (!gradle.ok) {
    return {
      ...META.releaseSigning,
      ...undetermined(`could not read the android build script: ${gradle.reason}`),
    };
  }

  if (!gradle.value.releaseCanUseDebugKey) {
    return {
      ...META.releaseSigning,
      ...ok("the release build type never takes the debug signing config."),
    };
  }

  const { conditionalOn } = gradle.value;

  if (conditionalOn && !conditionalFilePresent) {
    const { name } = conditionalOn;
    const looksIn = where(conditionalOn);
    return {
      ...META.releaseSigning,
      ...warn(
        `the release build falls back to the debug signing config when ${name} is missing, and ` +
          `${name} is not in the clone` +
          (looksIn === "" ? "" : ` — the build looks for it${looksIn}`) +
          ". The build will not fail: it will produce an artifact signed with the debug key, and " +
          "the store will reject it.",
        `${name} is gitignored, so it never reaches a clone. Supply the keystore through ` +
          "the environment instead, and make a release build without one an error rather than a " +
          "fallback — a build that cannot sign should stop, not succeed quietly.",
      ),
    };
  }

  if (conditionalOn) {
    return {
      ...META.releaseSigning,
      ...undetermined(
        `${conditionalOn.name} is present${where(conditionalOn)}, so the release key is ` +
          "used — but the build falls back to the debug signing config if it ever goes missing, " +
          "and does so without failing.",
      ),
    };
  }

  return {
    ...META.releaseSigning,
    ...undetermined(
      "the release build type can take the debug signing config; whether it does is decided by " +
        "something this cannot read.",
    ),
  };
}

export interface EnvironmentInput {
  uses: Known<LaneUses[]>;
  /** Names in this project's vault — where a variable ought to come from. */
  secretKeys: string[];
  /** Names in the server's own environment, which a run inherits. */
  serverEnv: string[];
  /** `required_secrets` from laneyard.yml: what the Fastfile cannot say for itself. */
  declared: string[];
  unread: Known<Unread>;
}

/**
 * Does the project have the variables its lanes need?
 *
 * This is the one credential question a Fastfile can actually answer. The other
 * checks ask "is there a key somewhere" and end up reasoning about absence;
 * this one reads `ENV.fetch("ASC_KEY_ID")` out of the lane and asks whether that
 * name exists — which has a real answer.
 *
 * It matters most for a project that keeps its variables in `fastlane/.env`.
 * That file is almost always gitignored, so it never reaches the clone a build
 * runs from: everything works on the machine it was written on, nothing works
 * on the build server, and nothing on screen says why. Naming the variables is
 * saying why.
 *
 * Two things it cannot see, and one answer to both. A variable read by a tool
 * the lane shells out to — `sentry-cli` wants `SENTRY_AUTH_TOKEN`, and the
 * Fastfile never mentions it — is invisible to any amount of parsing. So is one
 * fastlane reads for itself. `required_secrets` in laneyard.yml is where those
 * are declared, and they are treated exactly like the ones that were found.
 *
 * A variable present only in the server's own environment is reported rather
 * than quietly ticked: it works, but it works because of how this particular
 * server happened to be started, which is not something the project carries.
 */
export function checkEnvironment(input: EnvironmentInput): Check {
  const { uses, secretKeys, serverEnv, declared, unread } = input;
  if (!uses.ok) {
    return { ...META.environment, ...undetermined(`could not read the lanes: ${uses.reason}`) };
  }

  const read = uses.value.flatMap((lane) => lane.env ?? []);
  const required = [...new Set([...read, ...declared])].sort();

  if (required.length === 0) {
    const blind = unreadReason(unread);
    if (blind) {
      return {
        ...META.environment,
        ...undetermined(
          `no lane seen to read an environment variable — but ${blind}.`,
          DECLARE_SECRETS,
        ),
      };
    }
    return { ...META.environment, ...ok("no lane reads an environment variable.") };
  }

  const inVault = new Set(secretKeys);
  const inServer = new Set(serverEnv);
  const missing = required.filter((name) => !inVault.has(name) && !inServer.has(name));

  if (missing.length > 0) {
    return {
      ...META.environment,
      ...warn(
        `${nameList(missing)} ${missing.length === 1 ? "is" : "are"} needed by a lane and in ` +
          "neither the vault nor this server's environment: a run stops at the first one, or " +
          "builds with it empty.",
        "Store them from the secrets tab. A `fastlane/.env` does not travel — it is almost " +
          "always gitignored, so it never reaches the clone a build runs from.",
        "secrets",
      ),
    };
  }

  const borrowed = required.filter((name) => !inVault.has(name));
  if (borrowed.length > 0) {
    return {
      ...META.environment,
      ...ok(
        `every variable the lanes need is available — though ${nameList(borrowed)} ` +
          `${borrowed.length === 1 ? "comes" : "come"} from this server's own environment rather ` +
          `than the vault, so another machine would not find ${borrowed.length === 1 ? "it" : "them"}.`,
      ),
    };
  }

  return {
    ...META.environment,
    ...ok(`every variable the lanes need is in the vault: ${nameList(required)}.`),
  };
}

export interface ReadinessInput {
  probeRepository: () => Promise<unknown>;
  dependencies: DependenciesInput;
  /** Names only. A check has no business seeing a value, and never needs one. */
  secretKeys: string[];
  uses: Known<LaneUses[]>;
  /**
   * What this project builds for — from `laneyard.yml`, or from the repository
   * when the file says nothing. `Known` because a clone that failed is a reason
   * to say "could not tell", not to claim the repository holds nothing.
   */
  platforms: Known<Platform[]>;
  /**
   * The Appfile, which is the other half of a fastlane setup and where a
   * project older than Laneyard keeps its Play Store service account. Read by
   * the caller, like everything else here: no check touches the disk.
   */
  appfile: Known<AppfileFacts>;
  /** `.p8` files the repository carries, from the same listing as `platforms`. */
  keyFilesInRepo: Known<string[]>;
  /** What reading the Fastfile could not account for. See `Unread`. */
  unread: Known<Unread>;
  /** Names in the server's own environment, which a run inherits. */
  serverEnv: string[];
  /** `required_secrets` from laneyard.yml. */
  declaredSecrets: string[];
  /** What the android build script says about release signing. */
  androidSigning: Known<SigningFacts>;
  /** Whether the properties file signing is conditional on is in the clone. */
  signingFilePresent: boolean;
}

/** "all" is everyone's; the other two are shown only when they apply. */
export type SectionPlatform = "all" | Platform;

export interface ReadinessSection {
  platform: SectionPlatform;
  checks: Check[];
}

interface CheckRow {
  id: string;
  title: string;
  run: (input: ReadinessInput) => Promise<Check> | Check;
}

/**
 * The checklist itself: a table, so that adding a check is adding a row.
 *
 * Exported because the order it declares is the order the interface shows, and
 * a test that checks that should read the same list.
 */
export const SECTIONS: { platform: SectionPlatform; checks: CheckRow[] }[] = [
  {
    platform: "all",
    checks: [
      { ...META.repository, run: (i) => checkRepository(i.probeRepository) },
      { ...META.dependencies, run: (i) => checkDependencies(i.dependencies) },
      { ...META.blockingActions, run: (i) => checkBlockingActions(i.uses, i.unread) },
      {
        ...META.environment,
        run: (i) =>
          checkEnvironment({
            uses: i.uses,
            secretKeys: i.secretKeys,
            serverEnv: i.serverEnv,
            declared: i.declaredSecrets,
            unread: i.unread,
          }),
      },
    ],
  },
  {
    platform: "ios",
    checks: [
      {
        ...META.appStoreConnect,
        run: (i) =>
          checkAppStoreConnect({
            secretKeys: i.secretKeys,
            uses: i.uses,
            keyFilesInRepo: i.keyFilesInRepo,
            appfile: i.appfile,
            unread: i.unread,
          }),
      },
      { ...META.match, run: (i) => checkMatch(i.uses, i.secretKeys) },
    ],
  },
  {
    platform: "android",
    checks: [
      { ...META.androidKeystore, run: (i) => checkAndroidKeystore(i.uses, i.secretKeys, i.unread) },
      { ...META.playStore, run: (i) => checkPlayStore(i.uses, i.secretKeys, i.appfile, i.unread) },
      {
        ...META.releaseSigning,
        run: (i) =>
          checkReleaseSigning({
            gradle: i.androidSigning,
            conditionalFilePresent: i.signingFilePresent,
          }),
      },
    ],
  },
];

/**
 * Runs the sections that apply, and guarantees the list comes back whole.
 *
 * Each check already commits to not throwing. This wrapper exists because that
 * promise is worth exactly as much as the next person to edit a check: one
 * probe misbehaving must cost one line of the checklist, not the checklist.
 */
export async function runChecklist(input: ReadinessInput): Promise<ReadinessSection[]> {
  // Read once and defensively: this is the one value used outside a check body,
  // and a malformed one must not be the thing that empties the whole screen.
  const platforms =
    input.platforms && input.platforms.ok && Array.isArray(input.platforms.value)
      ? input.platforms.value
      : [];

  const sections = await Promise.all(
    SECTIONS.filter((s) => s.platform === "all" || platforms.includes(s.platform)).map(
      async (section) => ({
        platform: section.platform,
        checks: await Promise.all(
          section.checks.map(async ({ id, title, run }) => {
            try {
              return await run(input);
            } catch (cause) {
              return {
                id,
                title,
                state: "unknown" as const,
                detail: `the check itself failed: ${reasonOf(cause)}`,
              };
            }
          }),
        ),
      }),
    ),
  );

  // The shared section is always first and always present, so the note about a
  // missing platform sits under the checks that still applied.
  const shared = sections[0];
  if (platforms.length === 0 && shared) {
    shared.checks.push(platformNote(input.platforms ?? { ok: true, value: [] }));
  }

  return sections;
}

import type { CredentialKind } from "../credentials/kinds.js";
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
 * - **No check hands the user homework Laneyard could have done itself.** A
 *   repository that builds today keeps building unedited: Laneyard adapts to the
 *   project, never the other way round. So a check may say that something is
 *   missing, or that it cannot tell — it may not say to rewrite a Fastfile, a
 *   `build.gradle`, or a lane, for anything Laneyard is able to supply. Where a
 *   credential is what is missing, the recommendation is a signing block, which
 *   Laneyard materialises for the length of a run under the names the project
 *   already reads. Asking a question on the block's own form is allowed; asking
 *   for a commit is not.
 *
 * One consequence of that is worth stating on its own, because it decides how
 * half of the table reads: **a credential is required by a lane, never by a
 * platform.** Fastlane takes screenshots, runs tests and builds enterprise
 * artifacts as readily as it uploads. A project whose lanes only produce an
 * `.aab` needs the keystore that signs it and nothing else — no `.p8`, no
 * service account, because nothing is being sent anywhere. Each check therefore
 * derives what it wants from the actions the lanes were seen to call, and a
 * credential no lane could use is reported as not needed here rather than as a
 * gap.
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
  fixIn?: "secrets" | "signing";
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
  fixIn?: "secrets" | "signing";
}

const ok = (detail: string): Outcome => ({ state: "ok", detail });
const warn = (detail: string, fix?: string, fixIn?: "secrets" | "signing"): Outcome => ({
  state: "warn",
  detail,
  ...(fix === undefined ? {} : { fix }),
  ...(fixIn === undefined ? {} : { fixIn }),
});
// `fixIn` belongs here as much as on a warning: "could not tell" and "here is
// the one setting that would settle it" are not in tension, and a link is worth
// more on the line nobody knows what to do with than on the one that says so.
const undetermined = (detail: string, fix?: string, fixIn?: "secrets" | "signing"): Outcome => ({
  state: "unknown",
  detail,
  ...(fix === undefined ? {} : { fix }),
  ...(fixIn === undefined ? {} : { fixIn }),
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
    return { ...META.repository, ...ok("the remote answers without a password.") };
  } catch (cause) {
    return {
      ...META.repository,
      ...warn(
        reasonOf(cause),
        "Point `git_auth` at a passphrase-less SSH key in config.yml. A run that meets a prompt waits.",
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
      return { ...META.dependencies, ...ok("the bundle is installed.") };
    } catch (cause) {
      return {
        ...META.dependencies,
        ...warn(reasonOf(cause), "Run `bundle install` in the workspace."),
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
    return { ...META.dependencies, ...ok(`no Gemfile — runs use ${fastlane}, unpinned.`) };
  }

  return {
    ...META.dependencies,
    ...warn(
      "no Gemfile and no fastlane on the PATH: a run has nothing to execute.",
      'Add a Gemfile with `gem "fastlane"`, or install fastlane system-wide.',
    ),
  };
}

/** Any suffix: the key is split across several variables, and their names vary by lane. */
const API_KEY = /^APP_STORE_CONNECT_API_KEY/;

/**
 * The one name on this page that never worked.
 *
 * `APP_STORE_CONNECT_API_KEY_P8` appears nowhere in fastlane 2.237 — no action
 * declares it, so no lane can read it. Laneyard's own screen invented it and
 * asked people to store their `.p8` under it, and `API_KEY` above prefix-matches
 * it, so the result was a green tick for a value that reached nothing.
 *
 * Excluded rather than merely un-ticked: the value is still in the vault, and
 * someone who put it there is entitled to be told it does nothing instead of
 * being left with a checklist that has quietly gone silent about it.
 */
const DEAD_API_KEY = /^APP_STORE_CONNECT_API_KEY_P8$/;

const STORE_API_KEY =
  "Upload the `.p8` as an App Store Connect key block on the signing tab, with its key id and " +
  "issuer id. Nothing in the project has to change.";

/** The action whose whole job is to load a `.p8`, under both of its names. */
const ASC_KEY_ACTIONS = new Set(["app_store_connect_api_key", "asc_api_key"]);

/**
 * The actions that sign in to Apple, and therefore the ones that decide whether
 * this project needs a key at all.
 *
 * Deliberately wider than "uploads": `match` fetches from a certificates
 * repository but authenticates with App Store Connect to do it, and
 * `latest_testflight_build_number` is the version-numbering call half the
 * Fastfiles in existence make before they build anything. A lane that only
 * builds, tests or screenshots is in none of them, and that lane's project is
 * told it needs nothing — which is the whole point of asking.
 */
const APPLE_AUTH_ACTIONS = new Set([
  ...ASC_KEY_ACTIONS,
  "upload_to_testflight",
  "pilot",
  "upload_to_app_store",
  "deliver",
  "latest_testflight_build_number",
  "app_store_build_number",
  "download_dsyms",
  "precheck",
  "check_app_store_metadata",
  "produce",
  "create_app_online",
  "register_devices",
  "match",
  "sync_code_signing",
  "get_certificates",
  "cert",
  "get_provisioning_profile",
  "sigh",
]);

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
  /** The signing blocks that apply to this project, by kind. */
  blocks?: CredentialKind[];
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
 *
 * The vault holds two routes and both are answers: a block, which Laneyard
 * writes to disk for the run, and the loose variables a project stored before
 * blocks existed. Neither is preferred over the other here — a recommendation is
 * only made when there is nothing at all.
 */
export function checkAppStoreConnect(input: AppStoreConnectInput): Check {
  const { secretKeys, uses, keyFilesInRepo, appfile } = input;
  const blocks = input.blocks ?? [];

  if (blocks.includes("apple_asc")) {
    return { ...META.appStoreConnect, ...ok("a key block is in the vault.") };
  }

  if (secretKeys.some((key) => API_KEY.test(key) && !DEAD_API_KEY.test(key))) {
    return { ...META.appStoreConnect, ...ok("an API key is in the vault.") };
  }

  // The one place on this checklist where somebody is asked to redo work — and
  // it is work that never did anything. See `DEAD_API_KEY`.
  if (secretKeys.some((key) => DEAD_API_KEY.test(key))) {
    return {
      ...META.appStoreConnect,
      ...warn(
        "`APP_STORE_CONNECT_API_KEY_P8` is stored, and no fastlane action reads that name: no lane " +
          "can see it.",
        STORE_API_KEY,
        "signing",
      ),
    };
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
        `${nameList(inLanes.map((l) => l.lane))} supplies its own key — whether the \`.p8\` it names ` +
          "is on this machine is not something a Fastfile says.",
        STORE_API_KEY,
      ),
    };
  }

  // Nothing in the vault, and nothing named in a lane. Before reporting an
  // absence, ask whether the absence matters here: a key is wanted by a lane
  // that signs in to Apple, not by a project that happens to build for iOS.
  if (!uses.ok) {
    return { ...META.appStoreConnect, ...undetermined(`could not read the lanes: ${uses.reason}`) };
  }

  // Read once: three of the outcomes below turn on the same blindness.
  const blind = unreadReason(input.unread ?? { ok: true, value: READ_EVERYTHING });

  const signsIn = uses.value.some((lane) =>
    lane.actions.some((action) => APPLE_AUTH_ACTIONS.has(action.name)),
  );
  if (!signsIn) {
    if (blind) {
      return {
        ...META.appStoreConnect,
        ...undetermined(`no lane seen signing in to App Store Connect — but ${blind}.`, STORE_API_KEY),
      };
    }
    return { ...META.appStoreConnect, ...ok("no lane signs in to App Store Connect.") };
  }

  const p8 = keyFilesInRepo.ok ? keyFilesInRepo.value : [];
  if (p8.length > 0) {
    return {
      ...META.appStoreConnect,
      ...undetermined(
        `the repository carries ${nameList(p8)}: arranged, but nothing here says a lane loads it.`,
        STORE_API_KEY,
      ),
    };
  }

  if (secretKeys.includes("FASTLANE_SESSION")) {
    return {
      ...META.appStoreConnect,
      ...warn(
        "only a FASTLANE_SESSION: it expires, and the run that finds it expired asks for a code.",
        STORE_API_KEY,
        "signing",
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
        "the Appfile names an Apple ID and nothing else: two-factor stops the run to ask for a code.",
        STORE_API_KEY,
        "signing",
      ),
    };
  }

  // This one is a warning rather than a tick, so being wrong costs less — but
  // "in the lanes" is a claim about lanes that were read, and saying it about
  // lanes that could not be is still saying something untrue.
  if (blind) {
    return {
      ...META.appStoreConnect,
      ...undetermined(
        `no credential in the vault, the lanes or the repository — but ${blind}.`,
        STORE_API_KEY,
      ),
    };
  }

  return {
    ...META.appStoreConnect,
    ...warn(
      "no credential in the vault, the lanes or the repository: a lane that uploads will ask for " +
        "an Apple ID.",
      STORE_API_KEY,
      "signing",
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
        `${nameList(calls.map((c) => c.lane))} calls match, and MATCH_PASSWORD is not in the vault: ` +
          "match asks for the passphrase and waits.",
        "Store `MATCH_PASSWORD` on the secrets tab.",
        "secrets",
      ),
    };
  }

  const writable = calls.filter((c) => c.action.args["readonly"] === false);
  if (writable.length > 0) {
    return {
      ...META.match,
      ...warn(
        `${nameList(writable.map((c) => c.lane))} calls match with \`readonly: false\`: creating a ` +
          "certificate needs an Apple account interactively.",
        "Pass `readonly: true`.",
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
          `${nameList(undecided.map((c) => c.lane))}: Laneyard reads literals only, and will not guess.`,
        "Pass `readonly: true` in the call itself.",
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
        ...undetermined(`no lane seen calling an action known to stop and ask — but ${blind}.`),
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

/**
 * What to do about a keystore, said once.
 *
 * It used to say to store the passphrase loose and read it in the lane with
 * `storePassword: ENV["ANDROID_KEYSTORE_PASSWORD"]` — which is a Fastfile edit,
 * and so not Laneyard's to ask for. A block carries the file and the passphrases
 * together, and a run gets both without the project knowing anything about it.
 */
const STORE_KEYSTORE =
  "Upload the keystore as an android keystore block on the signing tab, with its alias and its two " +
  "passphrases. No lane has to change.";

export function checkAndroidKeystore(
  uses: Known<LaneUses[]>,
  secretKeys: string[],
  unread: Known<Unread> = { ok: true, value: READ_EVERYTHING },
  blocks: CredentialKind[] = [],
): Check {
  // Answered before the lanes are read, and on purpose: the question is whether
  // anything will stop and ask for a passphrase, and a block means nothing can —
  // whichever lane, and whether or not gradle is called by name.
  if (blocks.includes("android_keystore")) {
    return { ...META.androidKeystore, ...ok("a keystore block is in the vault.") };
  }

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
          ". Signing is configured somewhere a Fastfile does not show: `build.gradle`, " +
          "`key.properties`, or a build driven through flutter or react-native.",
        STORE_KEYSTORE,
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
      ...ok("no lane passes `storeFile` or `storePassword` to gradle."),
    };
  }

  const withoutPassphrase = signing.filter((c) => !("storePassword" in c.action.args));
  if (withoutPassphrase.length === 0) {
    return {
      ...META.androidKeystore,
      ...ok(`${nameList(signing.map((c) => c.lane))} passes \`storePassword\` in the call itself.`),
    };
  }

  if (secretKeys.some((key) => KEYSTORE_PASSWORD.test(key))) {
    return { ...META.androidKeystore, ...ok("a keystore passphrase is in the vault.") };
  }

  return {
    ...META.androidKeystore,
    ...warn(
      `${nameList(withoutPassphrase.map((c) => c.lane))} hands gradle a keystore, and no passphrase ` +
        "is in the vault: gradle asks for it and waits.",
      STORE_KEYSTORE,
      "signing",
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
  "A variable a shelled-out tool reads — `sentry-cli` and its `SENTRY_AUTH_TOKEN` — is not in the " +
  "Fastfile. List those under `required_secrets` in laneyard.yml.";

const STORE_PLAY_KEY =
  "Upload the service account JSON as a Play Store block on the signing tab.";

export function checkPlayStore(
  uses: Known<LaneUses[]>,
  secretKeys: string[],
  appfile: Known<AppfileFacts>,
  unread: Known<Unread> = { ok: true, value: READ_EVERYTHING },
  blocks: CredentialKind[] = [],
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
        ...undetermined(`no lane seen uploading to the Play Store — but ${blind}.`, STORE_PLAY_KEY),
      };
    }
    return { ...META.playStore, ...ok("no lane uploads to the Play Store.") };
  }

  // Either route answers: the block, or the loose variable a project stored
  // before blocks existed and which fastlane still reads exactly as it did.
  if (blocks.includes("play_service_account")) {
    return { ...META.playStore, ...ok("a service account block is in the vault.") };
  }

  if (secretKeys.some((key) => PLAY_JSON_KEY.test(key))) {
    return { ...META.playStore, ...ok("a service account is in the vault.") };
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
        `${nameList(named.map((c) => c.lane))} supplies its own service account — whether the file ` +
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
            "nothing says it is still valid.",
          STORE_PLAY_KEY,
        ),
      };
    }
    if (jsonKeyFile.kind === "literal") {
      return {
        ...META.playStore,
        ...undetermined(
          `the Appfile points \`json_key_file\` at ${jsonKeyFile.value} — whether that file is on ` +
            "this machine is another matter.",
          STORE_PLAY_KEY,
        ),
      };
    }
    if (jsonKeyFile.kind === "computed") {
      return {
        ...META.playStore,
        ...undetermined(
          "the Appfile computes `json_key_file`: only a run resolves it.",
          STORE_PLAY_KEY,
        ),
      };
    }
  }

  return {
    ...META.playStore,
    ...warn(
      `${nameList(calls.map((c) => c.lane))} uploads to the Play Store, and no service account is ` +
        "in the vault: supply stops and asks which credentials to use.",
      STORE_PLAY_KEY,
      "signing",
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
        ? "no Xcode project and no Gradle build in the repository, and laneyard.yml names none. " +
            "Only the checks above apply."
        : `could not tell: ${platforms.reason}. Only the checks above apply.`,
      "Add `platforms: [ios]`, `[android]` or both to laneyard.yml.",
    ),
  };
}

/**
 * What the keystore block says about the properties file Laneyard would write.
 *
 * Two settings, and both exist because a build script does not answer for them.
 * `propertyNames` are the keys written inside the file: the script reads them
 * out of a `Properties` object indexed by string, somewhere the parser never
 * goes, so these are the block's — the Flutter documentation's four by default.
 * `propertiesPath` is where the file goes when the script named it in a way that
 * left the directory unresolved.
 *
 * No passphrase, no alias, no path to the keystore itself: a check has no
 * business holding a secret, and this one needs none to say what will happen.
 */
export interface KeystoreSetting {
  /** The keys the file will carry, in the order they are written. */
  propertyNames: string[];
  /** The configured location, relative to the app, or null when unset. */
  propertiesPath: string | null;
}

/**
 * The one question the block's form can settle that nothing else can. Asked
 * here, answered there, and no file in the repository is touched either way.
 */
const SET_PROPERTIES_PATH =
  "Set the properties file path on the keystore block, relative to the app.";

export interface ReleaseSigningInput {
  /** The android build script, or why it could not be read. */
  gradle: Known<SigningFacts>;
  /** Whether the properties file it is conditional on is present in the clone. */
  conditionalFilePresent: boolean;
  /** The keystore block that would supply that file, or null when there is none. */
  keystore?: KeystoreSetting | null;
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
 * Where Laneyard would write that file, or null when it would write nothing.
 *
 * The same three answers `runner/gradle-properties.ts` arrives at, in the same
 * order, and that is not a coincidence to be maintained by hand: a check that
 * promised a file the runner then declined to write would be the worst line on
 * this page, because it would be reassuring and wrong. The configured path wins
 * outright, an unresolved scope with no configured path means nothing is
 * written, and everything else follows the scope the parser read.
 */
function writesAt(block: KeystoreSetting | null, file: PropertiesFile): string | null {
  if (block === null) return null;
  if (block.propertiesPath !== null && block.propertiesPath !== "") {
    return ` at ${block.propertiesPath}, the path the block names`;
  }
  if (file.scope === "unknown") return null;
  return where(file);
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
  const keystore = input.keystore ?? null;

  if (!gradle.ok) {
    return {
      ...META.releaseSigning,
      ...undetermined(`could not read the android build script: ${gradle.reason}`),
    };
  }

  if (!gradle.value.releaseCanUseDebugKey) {
    return { ...META.releaseSigning, ...ok("the release build never takes the debug config.") };
  }

  const { conditionalOn } = gradle.value;

  if (conditionalOn) {
    const { name } = conditionalOn;
    const writes = writesAt(keystore, conditionalOn);

    // What Laneyard will do, in the words of the file the build already asks
    // for. The keys are named rather than assumed silently: they are a
    // convention — the Flutter documentation's — and the one thing between a
    // signed artifact and a debug-signed one that nobody read out of the script.
    if (writes !== null && keystore !== null) {
      const supplied =
        `Laneyard writes ${name}${writes} for each run, with the keys ` +
        `${nameList(keystore.propertyNames)}.`;

      if (!conditionalFilePresent) {
        return {
          ...META.releaseSigning,
          ...ok(`${name} is not in the clone, so the debug config would apply. ${supplied}`),
        };
      }
      return {
        ...META.releaseSigning,
        ...ok(
          `${name} is present${where(conditionalOn)}, so the release key is used. Were it to go ` +
            `missing: ${supplied}`,
        ),
      };
    }

    // A block, and nowhere to put the file: the script names it on a receiver
    // the parser could not follow, so the directory is genuinely unknown. Two
    // directories, one right, and writing into the wrong one would leave the
    // build signing with the debug key next to a file that looked like the
    // answer. The block's own form settles it — a question, not a commit.
    if (keystore !== null && !conditionalFilePresent) {
      return {
        ...META.releaseSigning,
        ...undetermined(
          `${name} is not in the clone, so the debug config would apply. A keystore block is in ` +
            `the vault, but the build script names ${name} without saying which directory it ` +
            "resolves against.",
          SET_PROPERTIES_PATH,
          "signing",
        ),
      };
    }

    if (!conditionalFilePresent) {
      const looksIn = where(conditionalOn);
      return {
        ...META.releaseSigning,
        ...warn(
          `${name} is not in the clone` +
            (looksIn === "" ? "" : `, and the build looks for it${looksIn}`) +
            ". The build will not fail: it produces an artifact signed with the debug key, and the " +
            "store rejects it.",
          `${name} is gitignored, so it never reaches a clone. Upload the keystore as an android ` +
            `keystore block and Laneyard writes ${name} for each run. Nothing in the build script ` +
            "changes.",
          "signing",
        ),
      };
    }

    return {
      ...META.releaseSigning,
      ...undetermined(
        `${conditionalOn.name} is present${where(conditionalOn)}, so the release key is used — but ` +
          "the build falls back to the debug config if it goes missing, without failing.",
        keystore === null ? STORE_KEYSTORE : SET_PROPERTIES_PATH,
      ),
    };
  }

  return {
    ...META.releaseSigning,
    ...undetermined(
      "the release build can take the debug config; whether it does is decided somewhere this " +
        "cannot read.",
    ),
  };
}

export interface EnvironmentInput {
  uses: Known<LaneUses[]>;
  /** Names in this project's vault — where a variable ought to come from. */
  secretKeys: string[];
  /** Names in the server's own environment, which a run inherits. */
  serverEnv: string[];
  /**
   * The names the applicable signing blocks export into a run — the path of the
   * file Laneyard writes, and the fields stored beside it. Supplied, therefore
   * not missing: a project whose Fastfile reads `SUPPLY_JSON_KEY` and which has
   * uploaded a Play block is not short of anything.
   */
  blockNames?: string[];
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
 * A name a signing block exports counts as supplied. Laneyard writes that file
 * and sets that variable itself for the length of a run, so asking someone to
 * store it by hand would be asking them for the thing just uploaded.
 *
 * A variable present only in the server's own environment is reported rather
 * than quietly ticked: it works, but it works because of how this particular
 * server happened to be started, which is not something the project carries.
 */
export function checkEnvironment(input: EnvironmentInput): Check {
  const { uses, secretKeys, serverEnv, declared, unread } = input;
  const blockNames = input.blockNames ?? [];
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
        ...undetermined(`no lane seen reading an environment variable — but ${blind}.`, DECLARE_SECRETS),
      };
    }
    return { ...META.environment, ...ok("no lane reads an environment variable.") };
  }

  // A block's exported names sit with the vault keys rather than beside them: a
  // signing block *is* in the vault, and a name it exports reaches the run from
  // the same place, so nothing below has to distinguish the two.
  const inVault = new Set([...secretKeys, ...blockNames]);
  const inServer = new Set(serverEnv);
  const missing = required.filter((name) => !inVault.has(name) && !inServer.has(name));

  if (missing.length > 0) {
    return {
      ...META.environment,
      ...warn(
        `${nameList(missing)} ${missing.length === 1 ? "is" : "are"} needed by a lane and in ` +
          "neither the vault nor this server's environment: a run stops at the first one.",
        "Store them on the secrets tab. A `fastlane/.env` is gitignored, so it never reaches the clone.",
        "secrets",
      ),
    };
  }

  const borrowed = required.filter((name) => !inVault.has(name));
  if (borrowed.length > 0) {
    return {
      ...META.environment,
      ...ok(
        `every variable is available — though ${nameList(borrowed)} ` +
          `${borrowed.length === 1 ? "comes" : "come"} from this server's environment, not the ` +
          "vault, so another machine would not find " +
          `${borrowed.length === 1 ? "it" : "them"}.`,
      ),
    };
  }

  return { ...META.environment, ...ok(`every variable is in the vault: ${nameList(required)}.`) };
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
  /**
   * The signing blocks this project holds, by kind. Names of kinds, and nothing
   * else: no file, no field, no variable name.
   */
  blocks?: CredentialKind[];
  /**
   * The variable names those blocks export — read off the stored names by
   * `credentials/kinds.ts`, never decrypted. Names, like `secretKeys`.
   */
  blockNames?: string[];
  /** What the keystore block says about the properties file. See `KeystoreSetting`. */
  keystore?: KeystoreSetting | null;
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
            blockNames: i.blockNames ?? [],
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
            blocks: i.blocks ?? [],
          }),
      },
      { ...META.match, run: (i) => checkMatch(i.uses, i.secretKeys) },
    ],
  },
  {
    platform: "android",
    checks: [
      {
        ...META.androidKeystore,
        run: (i) => checkAndroidKeystore(i.uses, i.secretKeys, i.unread, i.blocks ?? []),
      },
      {
        ...META.playStore,
        run: (i) => checkPlayStore(i.uses, i.secretKeys, i.appfile, i.unread, i.blocks ?? []),
      },
      {
        ...META.releaseSigning,
        run: (i) =>
          checkReleaseSigning({
            gradle: i.androidSigning,
            conditionalFilePresent: i.signingFilePresent,
            keystore: i.keystore ?? null,
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

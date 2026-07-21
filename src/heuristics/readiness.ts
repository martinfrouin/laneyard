import { findBlockingActions } from "./blocking-actions.js";
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

export function checkAppStoreConnect(secretKeys: string[]): Check {
  if (secretKeys.some((key) => API_KEY.test(key))) {
    return { ...META.appStoreConnect, ...ok("an App Store Connect API key is in the vault.") };
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

  return {
    ...META.appStoreConnect,
    ...warn(
      "no App Store Connect credential in the vault: a lane that uploads will ask for an Apple ID.",
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

export function checkBlockingActions(uses: Known<LaneUses[]>): Check {
  if (!uses.ok) {
    return { ...META.blockingActions, ...undetermined(`could not read the lanes: ${uses.reason}`) };
  }

  const findings = uses.value.flatMap((lane) =>
    findBlockingActions(lane.actions).map((finding) => ({ lane: lane.lane, finding })),
  );

  if (findings.length === 0) {
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

export function checkAndroidKeystore(uses: Known<LaneUses[]>, secretKeys: string[]): Check {
  if (!uses.ok) {
    return { ...META.androidKeystore, ...undetermined(`could not read the lanes: ${uses.reason}`) };
  }

  const calls = uses.value.flatMap((lane) =>
    lane.actions.filter((a) => GRADLE_ACTIONS.has(a.name)).map((action) => ({ lane: lane.lane, action })),
  );

  if (calls.length === 0) {
    return { ...META.androidKeystore, ...ok("no lane builds with gradle.") };
  }

  const signing = calls.filter((c) => KEYSTORE_ARGS.some((arg) => arg in c.action.args));
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

const STORE_PLAY_KEY =
  "Store the service account JSON as `SUPPLY_JSON_KEY_DATA` from the secrets tab. " +
  "A service account does not expire on its own.";

export function checkPlayStore(uses: Known<LaneUses[]>, secretKeys: string[]): Check {
  if (!uses.ok) {
    return { ...META.playStore, ...undetermined(`could not read the lanes: ${uses.reason}`) };
  }

  const calls = uses.value.flatMap((lane) =>
    lane.actions
      .filter((a) => PLAY_UPLOAD_ACTIONS.has(a.name))
      .map((action) => ({ lane: lane.lane, action })),
  );

  if (calls.length === 0) {
    return { ...META.playStore, ...ok("no lane uploads to the Play Store.") };
  }

  if (secretKeys.some((key) => PLAY_JSON_KEY.test(key))) {
    return { ...META.playStore, ...ok("a Play Store service account is in the vault.") };
  }

  const named = calls.filter((c) => PLAY_KEY_ARGS.some((arg) => arg in c.action.args));
  if (named.length > 0) {
    // A path in a Fastfile says nothing about whether that file exists on this
    // machine. Neither a tick nor a warning would be honest.
    return {
      ...META.playStore,
      ...undetermined(
        `${nameList(named.map((c) => c.lane))} passes \`json_key\` in the call: whether that file is ` +
          "on this machine is not something a Fastfile says.",
        STORE_PLAY_KEY,
      ),
    };
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
      { ...META.blockingActions, run: (i) => checkBlockingActions(i.uses) },
    ],
  },
  {
    platform: "ios",
    checks: [
      { ...META.appStoreConnect, run: (i) => checkAppStoreConnect(i.secretKeys) },
      { ...META.match, run: (i) => checkMatch(i.uses, i.secretKeys) },
    ],
  },
  {
    platform: "android",
    checks: [
      { ...META.androidKeystore, run: (i) => checkAndroidKeystore(i.uses, i.secretKeys) },
      { ...META.playStore, run: (i) => checkPlayStore(i.uses, i.secretKeys) },
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

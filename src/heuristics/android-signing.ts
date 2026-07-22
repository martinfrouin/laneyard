/**
 * Whether a release build is actually signed with the release key.
 *
 * The pattern this exists for is in the Flutter documentation, and therefore in
 * thousands of projects:
 *
 *     signingConfig = if (keystorePropertiesFile.exists()) {
 *         signingConfigs.getByName("release")
 *     } else {
 *         signingConfigs.getByName("debug")
 *     }
 *
 * It is kind locally — `flutter run --release` works on a machine with no
 * keystore — and it is a trap everywhere else. `key.properties` is gitignored
 * by the same documentation, so it is by definition absent from a clone. The
 * release build then *succeeds*, produces an `.aab` signed with the debug key,
 * and the failure arrives minutes later from Google, saying nothing about
 * signing.
 *
 * Silent, late, and misleading — which is exactly the shape of failure a
 * checklist exists to move forward in time.
 *
 * Text, not a Gradle evaluation: running someone's build script to ask it a
 * question is not something a checklist may do. So this errs towards saying
 * nothing, and the check it feeds says "could not tell" rather than inventing a
 * verdict from a file it half understood.
 */

/**
 * Which directory Gradle resolves the name against.
 *
 * `rootProject.file("key.properties")` starts from the Gradle root — `android/`
 * in a Flutter project — and a bare `file("signing.properties")` starts from the
 * module the script belongs to, `android/app/`. Same name, two directories, and
 * a reader who only knows the name gets it right about half the time.
 *
 * `unknown` is the third answer, and it is a real one: the receiver may be a
 * variable this cannot follow. Saying so leaves the question open for someone
 * who can answer it, which is the whole point — a guess here would write a file
 * where nothing reads it, and the build would go on shipping the debug key.
 */
export type PropertiesScope = "root" | "module" | "unknown";

export interface PropertiesFile {
  /** The name as it appears in the script, `key.properties` and its like. */
  name: string;
  /** The directory that name is relative to. */
  scope: PropertiesScope;
}

export interface SigningFacts {
  /** A release build type that can take the debug signing config. */
  releaseCanUseDebugKey: boolean;
  /** The properties file the configuration is conditional on, if there is one. */
  conditionalOn: PropertiesFile | null;
}

export const NO_SIGNING_FACTS: SigningFacts = {
  releaseCanUseDebugKey: false,
  conditionalOn: null,
};

/**
 * `rootProject.file("key.properties")`, `file('signing.properties')` — the name,
 * and whatever the call was made on.
 *
 * The receiver is optional and captured separately because it is the whole
 * difference between two directories. It is matched as a dotted chain so that
 * the match starts at the receiver rather than at `file(` in the middle of it:
 * a pattern that ignored the receiver would read `keystoreDir.file(…)` as a bare
 * call and confidently name the wrong place.
 */
const PROPERTIES_FILE =
  /(?:([A-Za-z_][\w.]*)\s*\.\s*)?\bfile\s*\(\s*["']([^"']+\.properties)["']\s*\)/;

/**
 * `project.file` is the bare call spelled out — Gradle defines one as the other
 * — so both mean the module. Only `rootProject` climbs, and anything else is a
 * receiver whose directory this has no way to know.
 */
function scopeOf(receiver: string | undefined): PropertiesScope {
  if (receiver === undefined || receiver === "project") return "module";
  if (receiver === "rootProject") return "root";
  return "unknown";
}

/**
 * The `release { … }` block of `buildTypes`, as text.
 *
 * Braces are counted rather than matched with a regex, because the block nests
 * and a lazy match would stop at the first `}` — which is usually inside it.
 */
function releaseBlock(source: string): string | null {
  const start = /buildTypes\s*\{/.exec(source);
  if (!start) return null;

  const from = source.indexOf("release", start.index);
  if (from === -1) return null;

  const open = source.indexOf("{", from);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/** Reads an `android/app/build.gradle` or its Kotlin equivalent. Never throws. */
export function parseAndroidSigning(source: string): SigningFacts {
  const release = releaseBlock(source);
  if (release === null) return NO_SIGNING_FACTS;

  // `signingConfigs.debug` and `signingConfigs.getByName("debug")` are the two
  // spellings; both mean the release build may go out with the debug key.
  const usesDebug = /signingConfigs\s*(?:\.getByName\s*\(\s*["']debug["']\s*\)|\.debug\b)/.test(
    release,
  );

  const conditional = PROPERTIES_FILE.exec(source);

  return {
    releaseCanUseDebugKey: usesDebug,
    conditionalOn:
      usesDebug && conditional
        ? { name: conditional[2]!, scope: scopeOf(conditional[1]) }
        : null,
  };
}

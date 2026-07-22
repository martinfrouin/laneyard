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

export interface SigningFacts {
  /** A release build type that can take the debug signing config. */
  releaseCanUseDebugKey: boolean;
  /** The properties file the configuration is conditional on, if there is one. */
  conditionalOn: string | null;
}

export const NO_SIGNING_FACTS: SigningFacts = {
  releaseCanUseDebugKey: false,
  conditionalOn: null,
};

/** `rootProject.file("key.properties")`, `file('signing.properties')` — the name only. */
const PROPERTIES_FILE = /file\s*\(\s*["']([^"']+\.properties)["']\s*\)/;

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
    conditionalOn: usesDebug && conditional ? conditional[1]! : null,
  };
}

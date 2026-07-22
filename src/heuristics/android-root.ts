import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseAndroidSigning } from "./android-signing.js";
import type { SigningFacts } from "./android-signing.js";

/**
 * Which build script speaks for the android side of a project — asked once, in
 * one place.
 *
 * Two callers need the answer and they must never disagree. The checklist reads
 * the script to decide whether a release build could go out signed with the
 * debug key, and the runner writes the properties file that build asks for. If
 * one of them stopped at `app/build.gradle` while the other read
 * `android/app/build.gradle.kts`, the file would land where nothing reads it and
 * the checklist would report green over an artifact signed by the debug key —
 * the exact failure both of them exist to prevent. A shared list is what makes
 * that disagreement impossible rather than unlikely.
 *
 * The order is a preference, not a ranking of correctness: `android/app` is
 * where Flutter and React Native put theirs, and `app` is a repository that is
 * an Android project outright. A repository with both is a monorepo whose
 * fastlane directory should have pointed one level down, and the first match is
 * the honest guess to make until it does.
 */
export const ANDROID_BUILD_SCRIPTS = [
  "android/app/build.gradle.kts",
  "android/app/build.gradle",
  "app/build.gradle.kts",
  "app/build.gradle",
];

export interface AndroidBuild {
  /** Absolute path of the build script that was read. */
  scriptPath: string;
  /** The directory holding the script — `android/app/` in a Flutter project. */
  moduleDir: string;
  /** Its parent, which is what `rootProject` resolves against. */
  gradleRoot: string;
  facts: SigningFacts;
}

/**
 * Reads the first android build script under `root`, or null when there is none.
 *
 * `root` is the app root inside the clone, not the repository root: in a
 * monorepo the app is one directory down and so are its platform folders.
 *
 * Never throws. An unreadable script is the same as an absent one to both
 * callers — "could not tell" — and a checklist that raised here would turn a
 * question it failed to answer into an error page.
 */
export async function findAndroidBuild(root: string): Promise<AndroidBuild | null> {
  for (const candidate of ANDROID_BUILD_SCRIPTS) {
    const scriptPath = join(root, candidate);
    const text = await readFile(scriptPath, "utf8").catch(() => null);
    if (text === null) continue;

    const moduleDir = dirname(scriptPath);
    return { scriptPath, moduleDir, gradleRoot: dirname(moduleDir), facts: parseAndroidSigning(text) };
  }
  return null;
}

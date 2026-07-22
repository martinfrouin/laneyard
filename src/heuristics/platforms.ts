import { join } from "node:path";

/**
 * Which platforms a project builds for.
 *
 * Named knowledge of mobile toolchains — that `.xcodeproj` means Xcode, that
 * `build.gradle` means Gradle — hence its place in this module, and the
 * boundary that comes with it: nothing here refuses anything. It answers a
 * question; `setup` writes the answer down and the checklist reads it.
 *
 * It lives here rather than in `cli/detect.ts` because two callers need the
 * same answer. Setup proposes a configuration from it, and the checklist
 * decides which sections apply from it. Two copies of this reasoning would be
 * free to disagree about the same repository, and the checklist would be the
 * one that looked wrong.
 */

export type Platform = "ios" | "android";

/**
 * Where to look for the markers, given where the Fastfile turned out to be.
 *
 * Two places, and the order does not matter because the answer is a union.
 *
 * The repository root is the obvious one, and used to be the only one. It is
 * wrong on its own: the markers sit *beside* an app's fastlane folder, not
 * beside the repository root — `ios/Runner.xcodeproj` and `fastlane/` are
 * siblings, and both move together when the app is one directory of a
 * monorepo. A repository holding `app/fastlane/Fastfile` and
 * `app/ios/Runner.xcodeproj` reported "no Xcode project and no Gradle build",
 * because that is three levels down and the table reaches two.
 *
 * The app's own directory is the second, and it is the one laneyard already
 * knows: it asked where the Fastfile was during setup. Between them they cover
 * the arrangements that actually occur —
 *
 * - `fastlane/` and `*.xcodeproj` both at the root: a plain native app;
 * - `fastlane/`, `ios/`, `android/` at the root: React Native, Flutter;
 * - `app/fastlane/`, `app/ios/`, `app/android/`: the same app inside a monorepo;
 * - `ios/fastlane/`: a fastlane set up for one platform only, which then
 *   reports that one platform and not its sibling — right, since those lanes
 *   build one platform, and an irrelevant section is what teaches someone to
 *   ignore the screen.
 *
 * Keeping both roots rather than replacing one with the other is what makes
 * this strictly an addition: nothing the old behaviour found is lost.
 *
 * What is deliberately *not* done is deepening the table to `*​/*​/*` or `**`.
 * A third level would match `node_modules/some-package/ios/X.xcodeproj` and
 * `app/ios/Pods/Pods.xcodeproj`, and report iOS for an Android-only project on
 * the strength of a dependency's own Xcode project. `**` would do that and walk
 * every build directory to do it. Two levels from a root that is actually the
 * app is a better question than four levels from a root that is not.
 */
export function appRootOf(fastlaneDir: string | null | undefined): string {
  if (!fastlaneDir) return ".";
  // Repository-relative and always forward-slashed, whatever the platform.
  const parent = fastlaneDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return parent === "" ? "." : parent;
}

/**
 * The one directory to list, given where the Fastfile turned out to be.
 *
 * Not the repository root, which is what it used to be and what made a
 * repository holding `app/fastlane/Fastfile` and `app/ios/Runner.xcodeproj`
 * report "no Xcode project and no Gradle build": that is three levels down and
 * the table reaches two.
 *
 * Not both, either, though that was tempting — keeping the root as well would
 * have made this purely additive. It also means a project configured with
 * `ios/fastlane` is shown the Android section, on the strength of a sibling
 * `android/` folder those lanes never touch. The fastlane directory is not a
 * guess: setup asked for it and `laneyard.yml` records it, and it says which
 * app this project *is*. Trusting it is the difference between a checklist
 * about this project and a checklist about the repository it lives in.
 *
 * Anyone it gets wrong has the escape hatch the check itself names: `platforms`
 * in `laneyard.yml` is read first and skips all of this.
 *
 * What is deliberately not done is deepening the table to `*​/*​/*` or `**`. A
 * third level matches `node_modules/some-package/ios/X.xcodeproj` and
 * `app/ios/Pods/Pods.xcodeproj`, and would report iOS for an Android-only
 * project on the strength of a dependency. Two levels from a directory that is
 * actually the app beats four from one that is not.
 */
export function searchDir(from: string, appRoot: string | null | undefined): string {
  if (!appRoot || appRoot === "." || appRoot.startsWith("..")) return from;
  return join(from, appRoot);
}

export interface PlatformMarker {
  platform: Platform;
  globs: string[];
  /** Xcode projects are directories; Gradle builds are files. */
  onlyDirectories: boolean;
}

/**
 * What a repository looks like from the outside, as a table.
 *
 * The depth is deliberate: an app in a monorepo sits one level down
 * (`android/build.gradle`, `ios/App.xcodeproj`), which is where Flutter and
 * React Native put them.
 */
export const PLATFORM_MARKERS: PlatformMarker[] = [
  {
    platform: "ios",
    globs: ["*.xcodeproj", "*.xcworkspace", "*/*.xcodeproj", "*/*.xcworkspace"],
    onlyDirectories: true,
  },
  {
    platform: "android",
    globs: ["build.gradle", "build.gradle.kts", "*/build.gradle", "*/build.gradle.kts"],
    onlyDirectories: false,
  },
];

/**
 * Lists the paths of a directory matching a set of globs.
 *
 * Injected rather than imported so that this module keeps the property the rest
 * of `heuristics/` has: everything it needs arrives as an argument, and the
 * whole table is testable with plain values.
 */
export type FindPaths = (
  globs: string[],
  options: { onlyDirectories: boolean },
) => Promise<string[]>;

/**
 * What the repository contains.
 *
 * Never throws. An absent clone is a reason to answer "nothing found", not to
 * fail the checklist that was about to explain why the clone is absent.
 */
export async function detectPlatforms(find: FindPaths): Promise<Platform[]> {
  const found: Platform[] = [];

  // Sequential, and in the table's order, so the answer is stable: this list
  // decides the order of the sections someone reads.
  for (const marker of PLATFORM_MARKERS) {
    try {
      const paths = await find(marker.globs, { onlyDirectories: marker.onlyDirectories });
      if (paths.length > 0) found.push(marker.platform);
    } catch {
      // A marker that cannot be looked for is simply not found.
    }
  }

  return found;
}

/**
 * The configuration first, then the repository.
 *
 * An empty configured list counts as saying nothing: `platforms: []` is what a
 * commented-out line leaves behind, and reading it as "this project builds for
 * nothing" would silently empty the checklist.
 */
export function platformsOf(
  configured: Platform[] | undefined | null,
  detected: Platform[],
): Platform[] {
  const chosen = configured && configured.length > 0 ? configured : detected;
  // Normalised through the table: a hand-written `[android, ios]` must not
  // reorder the screen, and a platform named twice must not appear twice.
  return PLATFORM_MARKERS.map((m) => m.platform).filter((p) => chosen.includes(p));
}

/** The two steps in one call, for callers that have a directory to look at. */
export async function resolvePlatforms(
  configured: Platform[] | undefined | null,
  find: FindPaths,
): Promise<Platform[]> {
  // The repository is only listed when the configuration did not answer:
  // globbing a workspace costs a directory walk, and a project that says what
  // it builds for should not pay for one.
  if (configured && configured.length > 0) return platformsOf(configured, []);
  return platformsOf(undefined, await detectPlatforms(find));
}

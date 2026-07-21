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

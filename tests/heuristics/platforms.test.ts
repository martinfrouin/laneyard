import { describe, expect, it } from "vitest";
import {
  appRootOf,
  searchDir,
  PLATFORM_MARKERS,
  detectPlatforms,
  platformsOf,
  resolvePlatforms,
} from "../../src/heuristics/platforms.js";
import type { FindPaths } from "../../src/heuristics/platforms.js";

/**
 * A repository as a list of entries, matched against the markers' globs.
 *
 * Crude on purpose: the table is what is under test, not tinyglobby. The real
 * globbing is exercised through `detectProject` in `tests/cli/detect.test.ts`.
 */
const repository = (entries: { path: string; dir?: boolean }[]): FindPaths =>
  async (globs, { onlyDirectories }) =>
    entries
      .filter((e) => (onlyDirectories ? e.dir === true : e.dir !== true))
      .filter((e) =>
        globs.some((g) =>
          new RegExp(`^${g.replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`).test(e.path),
        ),
      )
      .map((e) => e.path);

const empty = repository([]);
const xcode = repository([{ path: "Sample.xcodeproj", dir: true }]);
const gradle = repository([{ path: "app/build.gradle" }]);
const both = repository([{ path: "Sample.xcodeproj", dir: true }, { path: "app/build.gradle" }]);

describe("appRootOf", () => {
  it("is the repository root when fastlane sits at the top", () => {
    expect(appRootOf("fastlane")).toBe(".");
  });

  /**
   * The bug this exists for: a monorepo holding `app/fastlane/Fastfile` and
   * `app/ios/Runner.xcodeproj` reported no platform at all, because the markers
   * were looked for from the repository root — three levels up from the Xcode
   * project, and the table reaches two.
   */
  it("is the app's directory when fastlane sits inside one", () => {
    expect(appRootOf("app/fastlane")).toBe("app");
    expect(appRootOf("packages/mobile/fastlane")).toBe("packages/mobile");
  });

  it("is the root when there is no Fastfile to go by", () => {
    expect(appRootOf(null)).toBe(".");
    expect(appRootOf(undefined)).toBe(".");
    expect(appRootOf("")).toBe(".");
  });

  it("does not trip over a trailing slash", () => {
    expect(appRootOf("app/fastlane/")).toBe("app");
  });
});

describe("searchDir", () => {
  it("is the directory given when the app is the repository", () => {
    expect(searchDir("/w", ".")).toBe("/w");
    expect(searchDir("/w", null)).toBe("/w");
    expect(searchDir("/w", "")).toBe("/w");
  });

  it("descends to the app's own directory when there is one", () => {
    expect(searchDir("/w", "app")).toBe("/w/app");
    expect(searchDir("/w", "packages/mobile")).toBe("/w/packages/mobile");
  });

  it("refuses to climb out of the directory it was given", () => {
    expect(searchDir("/w", "../elsewhere")).toBe("/w");
  });
});

/**
 * The arrangements that actually occur, each as the repository would look.
 *
 * Written as a table rather than as prose because the point is the spread: the
 * fix that made a Flutter app inside a monorepo work must not be a fix that
 * only makes *that* repository work.
 */
describe("detectPlatforms across real project layouts", () => {
  const layout = (paths: string[]): FindPaths => {
    const dirs = new Set(paths.filter((p) => p.endsWith("proj") || p.endsWith("workspace")));
    return (globs, { onlyDirectories }) => {
      const wanted = paths.filter((p) => (onlyDirectories ? dirs.has(p) : !dirs.has(p)));
      const rx = globs.map(
        (g) => new RegExp(`^${g.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`),
      );
      return Promise.resolve(wanted.filter((p) => rx.some((r) => r.test(p))));
    };
  };

  /** What a caller lists: the same tree seen from each of the search roots. */
  const seenFrom = (tree: string[], root: string): string[] =>
    root === "."
      ? tree
      : tree.filter((p) => p.startsWith(`${root}/`)).map((p) => p.slice(root.length + 1));

  const detect = async (tree: string[], fastlaneDir: string) => {
    // `join(".", "app")` normalises to `app`, so this comes back usable as-is.
    const root = searchDir(".", appRootOf(fastlaneDir));
    return detectPlatforms(layout(seenFrom(tree, root)));
  };

  it("plain native app: fastlane and the project both at the root", async () => {
    expect(await detect(["MyApp.xcodeproj", "fastlane/Fastfile"], "fastlane")).toEqual(["ios"]);
  });

  it("React Native or Flutter at the root", async () => {
    const tree = ["ios/Runner.xcodeproj", "android/build.gradle", "fastlane/Fastfile"];
    expect(await detect(tree, "fastlane")).toEqual(["ios", "android"]);
  });

  // The one that was broken: three levels down, and the table reaches two.
  it("the same app one directory down, in a monorepo", async () => {
    const tree = ["app/ios/Runner.xcodeproj", "app/android/build.gradle.kts", "app/fastlane/Fastfile"];
    expect(await detect(tree, "app/fastlane")).toEqual(["ios", "android"]);
  });

  it("two directories down, which is where a packages/ monorepo puts it", async () => {
    const tree = ["packages/mobile/ios/App.xcworkspace", "packages/mobile/fastlane/Fastfile"];
    expect(await detect(tree, "packages/mobile/fastlane")).toEqual(["ios"]);
  });

  // A fastlane set up for one platform reports that platform, and not its
  // sibling: those lanes build one thing, and an irrelevant section is what
  // teaches someone to ignore the screen.
  it("a per-platform fastlane reports its own platform only", async () => {
    const tree = ["ios/Runner.xcodeproj", "android/build.gradle", "ios/fastlane/Fastfile"];
    expect(await detect(tree, "ios/fastlane")).toEqual(["ios"]);
  });

  it("finds nothing in a repository that builds neither, rather than guessing", async () => {
    expect(await detect(["src/main.ts", "fastlane/Fastfile"], "fastlane")).toEqual([]);
  });

  // What the third glob level would have cost: a dependency's own Xcode project
  // reported as though the repository built for iOS.
  it("does not call an Android project iOS because a dependency ships an xcodeproj", async () => {
    const tree = [
      "app/android/build.gradle",
      "app/node_modules/some-package/ios/Thing.xcodeproj",
      "app/ios/Pods/Pods.xcodeproj",
      "app/fastlane/Fastfile",
    ];
    expect(await detect(tree, "app/fastlane")).toEqual(["android"]);
  });
});

describe("detectPlatforms", () => {
  it("finds iOS from an Xcode project", async () => {
    expect(await detectPlatforms(xcode)).toEqual(["ios"]);
  });

  it("finds Android from a Gradle build", async () => {
    expect(await detectPlatforms(gradle)).toEqual(["android"]);
  });

  it("finds both when the repository holds both", async () => {
    // A repository is not one platform or the other: a React Native or Flutter
    // app is routinely both, and reporting only the first would hide half the
    // checklist from the person who needs it most.
    expect(await detectPlatforms(both)).toEqual(["ios", "android"]);
  });

  it("finds neither in a repository with neither, rather than assuming one", async () => {
    expect(await detectPlatforms(empty)).toEqual([]);
  });

  it("never throws when the repository cannot be listed", async () => {
    // An absent clone is a reason to say "nothing found", not to fail the
    // checklist that was about to explain why the clone is absent.
    const broken: FindPaths = async () => {
      throw new Error("ENOENT: no such file or directory");
    };
    await expect(detectPlatforms(broken)).resolves.toEqual([]);
  });

  it("reports in the table's order, whatever order the markers matched in", async () => {
    const reversed = repository([
      { path: "app/build.gradle" },
      { path: "Sample.xcodeproj", dir: true },
    ]);
    expect(await detectPlatforms(reversed)).toEqual(PLATFORM_MARKERS.map((m) => m.platform));
  });
});

describe("platformsOf", () => {
  it("takes the configuration over what was detected", async () => {
    // A value written down can be corrected; one re-inferred on every check
    // cannot. A repository that carries an Xcode project it never builds is
    // exactly the case the configuration exists for.
    expect(platformsOf(["android"], ["ios"])).toEqual(["android"]);
  });

  it("falls back to detection when the configuration says nothing", () => {
    expect(platformsOf(undefined, ["ios"])).toEqual(["ios"]);
  });

  it("treats an empty list in the configuration as saying nothing", () => {
    expect(platformsOf([], ["android"])).toEqual(["android"]);
  });

  it("puts a configured list in the table's order, so the screen is stable", () => {
    expect(platformsOf(["android", "ios"], [])).toEqual(["ios", "android"]);
  });

  it("ignores a platform named twice", () => {
    expect(platformsOf(["ios", "ios"], [])).toEqual(["ios"]);
  });

  it("is empty when neither the configuration nor the repository says anything", () => {
    expect(platformsOf(undefined, [])).toEqual([]);
  });
});

describe("resolvePlatforms", () => {
  it("does not look at the repository when the configuration already answered", async () => {
    let looked = false;
    const find: FindPaths = async () => {
      looked = true;
      return [];
    };
    expect(await resolvePlatforms(["ios"], find)).toEqual(["ios"]);
    expect(looked).toBe(false);
  });

  it("falls back to the repository", async () => {
    expect(await resolvePlatforms(undefined, both)).toEqual(["ios", "android"]);
  });
});

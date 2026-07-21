import { describe, expect, it } from "vitest";
import {
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

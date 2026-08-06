import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseGradleVersionName,
  parsePbxprojVersion,
  parsePubspecVersion,
  readAppVersion,
} from "../../src/heuristics/app-version.js";
import { tmpDir } from "../fixtures/repos.js";

describe("parsePubspecVersion", () => {
  it("reads the version and drops Flutter's own build number", () => {
    // The `+87` is a second counter, and the screen already shows Laneyard's.
    expect(parsePubspecVersion("name: popotes\nversion: 1.4.2+87\n")).toBe("1.4.2");
  });

  it("reads one without a build number, quoted or not", () => {
    expect(parsePubspecVersion("version: 2.0.0\n")).toBe("2.0.0");
    expect(parsePubspecVersion('version: "2.0.0"\n')).toBe("2.0.0");
  });

  it("ignores a trailing comment", () => {
    expect(parsePubspecVersion("version: 1.0.0+3 # bumped by fastlane\n")).toBe("1.0.0");
  });

  it("answers null rather than guessing at something that is not a version", () => {
    expect(parsePubspecVersion("name: popotes\n")).toBeNull();
    expect(parsePubspecVersion("version:\n")).toBeNull();
    // A version left as a template is not one: printing it would put the
    // placeholder on screen where a number belongs.
    expect(parsePubspecVersion("version: $VERSION\n")).toBeNull();
  });

  it("does not read a nested key that happens to end in version", () => {
    expect(parsePubspecVersion("environment:\n  sdk_version: 3.5.0\n")).toBeNull();
  });
});

describe("parseGradleVersionName", () => {
  it("reads both dialects", () => {
    expect(parseGradleVersionName('android { defaultConfig { versionName "1.4.2" } }')).toBe("1.4.2");
    expect(parseGradleVersionName('android { defaultConfig { versionName = "1.4.2" } }')).toBe("1.4.2");
  });

  /**
   * A Flutter project's build script reads `flutterVersionName`, which is the
   * name of where the version lives rather than the version. Taking it would
   * print `flutterVersionName` beside a build number as though it were one.
   */
  it("takes a literal only, never the name of a variable", () => {
    expect(parseGradleVersionName("versionName flutterVersionName")).toBeNull();
    expect(parseGradleVersionName("versionName = project.appVersion")).toBeNull();
  });

  it("is not fooled by a property whose name ends the same way", () => {
    expect(parseGradleVersionName('def previousVersionName = "0.9.0"')).toBeNull();
  });
});

describe("parsePbxprojVersion", () => {
  it("reads MARKETING_VERSION", () => {
    expect(parsePbxprojVersion("\t\t\t\tMARKETING_VERSION = 1.4.2;\n")).toBe("1.4.2");
    expect(parsePbxprojVersion('\t\t\t\tMARKETING_VERSION = "1.4.2";\n')).toBe("1.4.2");
  });

  it("skips a build setting that points at another build setting", () => {
    expect(
      parsePbxprojVersion(
        "MARKETING_VERSION = $(APP_VERSION);\nMARKETING_VERSION = 3.1;\n",
      ),
    ).toBe("3.1");
  });

  it("answers null when the project has none", () => {
    expect(parsePbxprojVersion("CURRENT_PROJECT_VERSION = 12;")).toBeNull();
  });
});

describe("readAppVersion", () => {
  it("prefers the pubspec, which is what the platform files are generated from", async () => {
    const root = await tmpDir("laneyard-version-");
    await writeFile(join(root, "pubspec.yaml"), "name: popotes\nversion: 1.4.2+87\n");
    await mkdir(join(root, "android", "app"), { recursive: true });
    await writeFile(
      join(root, "android", "app", "build.gradle"),
      "android { defaultConfig { versionName flutterVersionName } }",
    );

    expect(await readAppVersion(root)).toBe("1.4.2");
  });

  it("falls back to the android build script", async () => {
    const root = await tmpDir("laneyard-version-");
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(
      join(root, "app", "build.gradle.kts"),
      'android { defaultConfig { versionName = "3.0.1" } }',
    );

    expect(await readAppVersion(root)).toBe("3.0.1");
  });

  it("reads an Xcode project beside the app, and one folder down", async () => {
    const flat = await tmpDir("laneyard-version-");
    await mkdir(join(flat, "App.xcodeproj"), { recursive: true });
    await writeFile(join(flat, "App.xcodeproj", "project.pbxproj"), "MARKETING_VERSION = 2.3;");
    expect(await readAppVersion(flat)).toBe("2.3");

    const nested = await tmpDir("laneyard-version-");
    await mkdir(join(nested, "ios", "Runner.xcodeproj"), { recursive: true });
    await writeFile(
      join(nested, "ios", "Runner.xcodeproj", "project.pbxproj"),
      "MARKETING_VERSION = 2.4;",
    );
    expect(await readAppVersion(nested)).toBe("2.4");
  });

  /**
   * A version it could not read is a column left empty. A version it invented
   * would be printed beside a build number as though somebody had checked it.
   */
  it("answers null for a repository that says nothing, and for one that is not there", async () => {
    expect(await readAppVersion(await tmpDir("laneyard-version-"))).toBeNull();
    expect(await readAppVersion("/nonexistent")).toBeNull();
  });
});

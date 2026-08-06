import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ANDROID_BUILD_SCRIPTS } from "./android-root.js";

/**
 * What version of the app a run built.
 *
 * The number Laneyard hands out counts builds; this is the other half — the
 * version a human reads on a store page, and the one that says which of forty
 * runs produced the `1.4.2` somebody is now asking about. Laneyard never sets
 * it: it belongs to the project, and this only reads it back.
 *
 * Read from the source, not from the artifact. An `.ipa` keeps it in a binary
 * property list and an `.apk` in a binary manifest, so reading either means
 * carrying a zip reader and two format parsers for a line of text — and neither
 * exists for a run that failed, which is exactly the run somebody comes back to.
 * The working tree is there either way, and it is there after the lane has
 * finished: a Fastfile that bumps the version reports the bumped one, which is
 * what shipped.
 *
 * Three places, in the order that settles who wins when a repository has more
 * than one. Flutter's `pubspec.yaml` is first because it is the source the
 * platform files are generated from — a Flutter project's `build.gradle` reads
 * `flutterVersionName`, which is not a version but the name of where the real
 * one lives. Then the android build script, then the Xcode project.
 *
 * Never throws, and answers null rather than guessing. A version this could not
 * read is a column left empty; a version it invented would be printed beside a
 * build number as though somebody had checked it.
 */

/** A version as written by a person: `1.4.2`, `2026.1`, `1.0.0-rc.1`. */
const PLAUSIBLE = /^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/;

/**
 * Flutter's `version: 1.4.2+87` — the part before the `+`.
 *
 * The `+87` is Flutter's own build number, and dropping it is deliberate: the
 * build number shown beside this one is Laneyard's, and printing two different
 * numbers under one word would be worse than printing neither.
 */
export function parsePubspecVersion(text: string): string | null {
  const line = /^version:\s*(["']?)([^"'#\s]+)\1\s*(#.*)?$/m.exec(text);
  const version = line?.[2]?.split("+")[0];
  return version && PLAUSIBLE.test(version) ? version : null;
}

/**
 * Gradle's `versionName "1.4.2"`, in either dialect and however it is spaced.
 *
 * Only a literal counts. `versionName flutterVersionName` and
 * `versionName = project.appVersion` name a variable this cannot resolve, and
 * reading the variable's own name as the version would put `flutterVersionName`
 * on screen where a version belongs.
 */
export function parseGradleVersionName(text: string): string | null {
  const found = /(?:^|\s)versionName\s*(?:=|\()?\s*["']([^"']+)["']/m.exec(text);
  const version = found?.[1];
  return version && PLAUSIBLE.test(version) ? version : null;
}

/**
 * Xcode's `MARKETING_VERSION = 1.4.2;`, which is what `CFBundleShortVersionString`
 * resolves to in every project made this decade.
 *
 * A project carries one per build configuration and they are normally identical;
 * the first literal is taken. `$(MARKETING_VERSION)` and friends are skipped for
 * the reason the gradle parser skips a bare identifier.
 */
export function parsePbxprojVersion(text: string): string | null {
  for (const m of text.matchAll(/MARKETING_VERSION\s*=\s*"?([^";\n]+)"?\s*;/g)) {
    const version = m[1]?.trim();
    if (version && PLAUSIBLE.test(version)) return version;
  }
  return null;
}

/**
 * The `.xcodeproj` folders under an app root, at the two depths that occur.
 *
 * The same reach as `PLATFORM_MARKERS` and for the same reason: `ios/App.xcodeproj`
 * is where Flutter and React Native put theirs, `App.xcodeproj` is a plain
 * native app, and a third level would find `Pods/Pods.xcodeproj` and answer with
 * a dependency's version.
 */
async function xcodeProjects(root: string): Promise<string[]> {
  const found: string[] = [];
  const listing = async (dir: string): Promise<string[]> =>
    readdir(dir, { withFileTypes: true })
      .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
      .catch(() => []);

  const top = await listing(root);
  for (const name of top) {
    if (name.endsWith(".xcodeproj")) found.push(join(root, name));
  }
  for (const dir of top) {
    if (dir.endsWith(".xcodeproj") || dir.startsWith(".")) continue;
    for (const name of await listing(join(root, dir))) {
      if (name.endsWith(".xcodeproj")) found.push(join(root, dir, name));
    }
  }
  return found;
}

/**
 * The app's version as the working tree holds it, or null.
 *
 * `root` is the app root inside the clone — the repository root for a plain app,
 * `app/` for one in a monorepo — the same directory `findAndroidBuild` is given.
 */
export async function readAppVersion(root: string): Promise<string | null> {
  const read = (path: string): Promise<string | null> => readFile(path, "utf8").catch(() => null);

  const pubspec = await read(join(root, "pubspec.yaml"));
  if (pubspec !== null) {
    const version = parsePubspecVersion(pubspec);
    if (version !== null) return version;
  }

  for (const candidate of ANDROID_BUILD_SCRIPTS) {
    const text = await read(join(root, candidate));
    if (text === null) continue;
    const version = parseGradleVersionName(text);
    if (version !== null) return version;
  }

  for (const project of await xcodeProjects(root)) {
    const text = await read(join(project, "project.pbxproj"));
    if (text === null) continue;
    const version = parsePbxprojVersion(text);
    if (version !== null) return version;
  }

  return null;
}

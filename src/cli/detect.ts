import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { glob } from "tinyglobby";

const exec = promisify(execFile);

export interface Detection {
  slug: string;
  gitUrl: string | null;
  defaultBranch: string;
  /**
   * Path of the folder holding the Fastfile, **relative to the repository root**,
   * or null if none was found.
   */
  fastlaneDir: string | null;
  runtime: "bundle" | "system";
  artifactGlobs: string[];
  platform: "ios" | "android" | "unknown";
  /** Where the command was run, relative to the repository root. "" at the root. */
  subPath: string;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const gitOr = async (args: string[], cwd: string, fallback: string | null): Promise<string | null> => {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout.trim() || fallback;
  } catch {
    return fallback;
  }
};

/** A folder name isn't a slug: normalize it, but never fail. */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "project" : s;
}

/** `git@host:owner/name.git` or `https://host/owner/name.git` → `name`. */
function repositoryName(url: string | null): string | null {
  if (!url) return null;
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop();
  if (!last) return null;
  const name = last.replace(/\.git$/, "");
  return name === "" ? null : name;
}

/** Turns an absolute path into a repository-relative one, with forward slashes. */
const toRepoPath = (root: string, absolute: string): string =>
  relative(root, absolute).split(sep).join("/");

/**
 * Inspects an existing project and proposes a configuration.
 *
 * **Every path it reports is relative to the repository root, not to the
 * directory the command was run in.** That distinction is the whole difficulty:
 * Laneyard clones the repository, so a Fastfile at `app/fastlane` is at
 * `app/fastlane` in the workspace no matter which folder someone happened to
 * be standing in when they ran `laneyard setup`. Measuring from the current
 * directory produced a configuration that looked right and pointed nowhere.
 *
 * Decides nothing irreversible: everything it returns is a proposal the user
 * sees and can correct before it's written.
 */
export async function detectProject(dir: string): Promise<Detection> {
  // Without a repository there is nothing to clone; `runAddCommand` refuses
  // shortly after, so falling back to `dir` here only keeps this function total.
  // Both sides are resolved before being compared: on macOS the temporary
  // directory is a symlink, and git always answers with the real path — so a
  // raw comparison yields a nonsense `../../private/...` relative path.
  const here = await realpath(dir).catch(() => dir);
  const root = await realpath(
    (await gitOr(["rev-parse", "--show-toplevel"], dir, null)) ?? dir,
  ).catch(() => dir);
  const subPath = toRepoPath(root, here);

  // Look from where the user is standing — that is what they meant by "this
  // project" — but report what is found relative to the repository root.
  const fastfiles = await glob(["fastlane/Fastfile", "*/fastlane/Fastfile", "*/*/fastlane/Fastfile"], {
    cwd: dir,
    absolute: true,
    onlyFiles: true,
  });
  const fastfile = fastfiles.sort((a, b) => a.length - b.length)[0] ?? null;
  const fastlaneDir = fastfile
    ? toRepoPath(root, await realpath(join(fastfile, "..")).catch(() => join(fastfile, "..")))
    : null;

  const isIos =
    (await glob(["*.xcodeproj", "*.xcworkspace", "*/*.xcodeproj"], { cwd: dir, onlyDirectories: true }))
      .length > 0;
  const isAndroid =
    (await glob(["build.gradle", "build.gradle.kts", "*/build.gradle", "*/build.gradle.kts"], {
      cwd: dir,
      onlyFiles: true,
    })).length > 0;

  // Artifact patterns are anchored to the sub-project too. In a monorepo an
  // unanchored `**/*.ipa` would collect a sibling app's build as if it were
  // this one's — and nothing downstream would notice.
  const prefix = subPath === "" ? "" : `${subPath}/`;
  const artifactGlobs: string[] = [];
  if (isIos) artifactGlobs.push(`${prefix}**/*.ipa`, `${prefix}**/*.app.dSYM.zip`);
  if (isAndroid) artifactGlobs.push(`${prefix}**/*.apk`, `${prefix}**/*.aab`);

  const gitUrl = await gitOr(["remote", "get-url", "origin"], dir, null);

  // The slug names the repository, and the sub-project when there is one: two
  // apps in the same monorepo must not both want to be called `app`.
  //
  // The name comes from the remote rather than the local folder, because the
  // folder is an accident of where someone cloned. `…/popotheque.git` checked
  // out into `~/work/current` should still be called `popotheque`.
  const repoName = repositoryName(gitUrl) ?? basename(root);
  const slug = slugify(subPath === "" ? repoName : `${repoName}-${subPath}`);

  return {
    slug,
    gitUrl,
    defaultBranch: (await gitOr(["rev-parse", "--abbrev-ref", "HEAD"], dir, "main")) ?? "main",
    fastlaneDir,
    // A Gemfile beside the Fastfile is the one fastlane will use, not one at the
    // repository root — `bundle exec` runs from the sub-project.
    runtime: (await exists(join(dir, "Gemfile"))) ? "bundle" : "system",
    artifactGlobs,
    platform: isIos ? "ios" : isAndroid ? "android" : "unknown",
    subPath,
  };
}

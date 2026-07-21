import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { glob } from "tinyglobby";

const exec = promisify(execFile);

export interface Detection {
  slug: string;
  gitUrl: string | null;
  defaultBranch: string;
  /** Relative path of the folder containing the Fastfile, or null if not found. */
  fastlaneDir: string | null;
  runtime: "bundle" | "system";
  artifactGlobs: string[];
  platform: "ios" | "android" | "unknown";
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

/**
 * Inspects an existing project and proposes a configuration.
 *
 * Decides nothing irreversible: everything it returns is a proposal the
 * user sees and can correct before it's written.
 */
export async function detectProject(dir: string): Promise<Detection> {
  // The Fastfile can be at the root or under a subfolder, for monorepos.
  const fastfiles = await glob(["fastlane/Fastfile", "*/fastlane/Fastfile", "*/*/fastlane/Fastfile"], {
    cwd: dir,
    absolute: true,
    onlyFiles: true,
  });
  const fastfile = fastfiles.sort((a, b) => a.length - b.length)[0] ?? null;
  const fastlaneDir = fastfile
    ? relative(dir, join(fastfile, "..")).split(sep).join("/")
    : null;

  const isIos =
    (await glob(["*.xcodeproj", "*.xcworkspace", "*/*.xcodeproj"], { cwd: dir, onlyDirectories: true }))
      .length > 0;
  const isAndroid =
    (await glob(["build.gradle", "build.gradle.kts", "*/build.gradle", "*/build.gradle.kts"], {
      cwd: dir,
      onlyFiles: true,
    })).length > 0;

  const artifactGlobs: string[] = [];
  if (isIos) artifactGlobs.push("**/*.ipa", "**/*.app.dSYM.zip");
  if (isAndroid) artifactGlobs.push("**/*.apk", "**/*.aab");

  return {
    slug: slugify(basename(dir)),
    gitUrl: await gitOr(["remote", "get-url", "origin"], dir, null),
    defaultBranch: (await gitOr(["rev-parse", "--abbrev-ref", "HEAD"], dir, "main")) ?? "main",
    fastlaneDir,
    runtime: (await exists(join(dir, "Gemfile"))) ? "bundle" : "system",
    artifactGlobs,
    platform: isIos ? "ios" : isAndroid ? "android" : "unknown",
  };
}

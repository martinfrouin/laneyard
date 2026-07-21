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
  /** Chemin relatif du dossier contenant le Fastfile, ou null si introuvable. */
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

/** Un nom de dossier n'est pas un slug : on le normalise sans jamais échouer. */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "projet" : s;
}

/**
 * Inspecte un projet existant et propose une configuration.
 *
 * Ne décide rien d'irréversible : tout ce qu'elle renvoie est une proposition que
 * l'utilisateur voit et peut corriger avant écriture.
 */
export async function detectProject(dir: string): Promise<Detection> {
  // Le Fastfile peut être à la racine ou sous un sous-dossier, cas des monorepos.
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

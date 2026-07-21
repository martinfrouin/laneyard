import { mkdir, rename, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { glob } from "tinyglobby";

export interface CollectedArtifact {
  filename: string;
  path: string;
  size: number;
  kind: string;
}

export function guessKind(filename: string): string {
  const name = filename.toLowerCase();
  if (name.endsWith(".dsym.zip") || name.includes(".dsym")) return "dsym";
  switch (extname(name)) {
    case ".ipa":
      return "ipa";
    case ".apk":
      return "apk";
    case ".aab":
      return "aab";
    default:
      return "other";
  }
}

/**
 * Moves out of the workspace any file matching the configured patterns.
 *
 * The patterns are the only contract: Laneyard doesn't parse the run's
 * output to guess paths. Moving — rather than copying — avoids doubling
 * disk usage and guarantees the next build won't accidentally reuse a
 * stale artifact.
 */
export async function collectArtifacts(
  workspacePath: string,
  patterns: string[],
  destDir: string,
): Promise<CollectedArtifact[]> {
  if (patterns.length === 0) return [];

  const matches = await glob(patterns, {
    cwd: workspacePath,
    absolute: true,
    onlyFiles: true,
    dot: false,
  });
  if (matches.length === 0) return [];

  await mkdir(destDir, { recursive: true });

  const used = new Set<string>();
  const collected: CollectedArtifact[] = [];

  for (const source of matches.sort()) {
    let filename = basename(source);
    if (used.has(filename)) {
      // Two paths can produce the same name; we prefix rather than overwrite.
      const ext = extname(filename);
      const stem = filename.slice(0, filename.length - ext.length);
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n += 1;
      filename = `${stem}-${n}${ext}`;
    }
    used.add(filename);

    const dest = join(destDir, filename);
    await rename(source, dest);
    const info = await stat(dest);

    collected.push({ filename, path: dest, size: info.size, kind: guessKind(filename) });
  }

  return collected;
}

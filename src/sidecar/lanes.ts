import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheStore } from "../db/cache.js";
import type { Invoke } from "./bridge.js";

export interface Lane {
  name: string;
  platform: string | null;
  description: string;
  private: boolean;
}

/**
 * Empreinte de tout le dossier fastlane, pas seulement du Fastfile :
 * un Appfile, un Pluginfile ou un fichier importé changent les lanes tout autant.
 */
async function hashFastlaneDir(root: string, fastlaneDir: string): Promise<string> {
  const dir = join(root, fastlaneDir);
  const hash = createHash("sha256");
  const entries = (await readdir(dir, { withFileTypes: true, recursive: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();

  for (const file of entries) {
    hash.update(file);
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

export class LaneReader {
  constructor(
    private readonly cache: CacheStore,
    private readonly invoke: Invoke,
  ) {}

  async read(slug: string, workspacePath: string, fastlaneDir: string): Promise<Lane[]> {
    const hash = await hashFastlaneDir(workspacePath, fastlaneDir);

    const cached = this.cache.get(slug, hash);
    if (cached) return cached as Lane[];

    const res = await this.invoke("lanes", workspacePath, fastlaneDir);
    if (!res.ok) throw new Error(res.error);

    const lanes = res["lanes"] as Lane[];
    this.cache.put(slug, hash, lanes);
    return lanes;
  }
}

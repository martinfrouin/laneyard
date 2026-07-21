import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheStore } from "../db/cache.js";
import type { Invoke } from "./bridge.js";

export interface UsedAction {
  name: string;
  args: Record<string, unknown>;
}

export interface LaneUses {
  lane: string;
  actions: UsedAction[];
}

/**
 * Hash of the whole fastlane folder, not just the Fastfile:
 * an Appfile, a Pluginfile, or an imported file change the lanes just as much.
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

export class UsesReader {
  constructor(
    private readonly cache: CacheStore,
    private readonly invoke: Invoke,
  ) {}

  async read(slug: string, workspacePath: string, fastlaneDir: string): Promise<LaneUses[]> {
    const hash = await hashFastlaneDir(workspacePath, fastlaneDir);

    const cached = this.cache.get(slug, "uses", hash);
    if (cached) return cached as LaneUses[];

    const res = await this.invoke("uses", workspacePath, fastlaneDir);
    if (!res.ok) throw new Error(res.error);

    const lanes = res["lanes"] as LaneUses[];
    this.cache.put(slug, "uses", hash, lanes);
    return lanes;
  }
}

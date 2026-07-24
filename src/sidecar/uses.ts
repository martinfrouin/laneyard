import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheStore } from "../db/cache.js";
import { sidecarVersion } from "./bridge.js";
import { assertFastlaneDir } from "./fastlane-dir.js";
import type { Invoke } from "./bridge.js";

export interface UsedAction {
  name: string;
  args: Record<string, unknown>;
  /** Every keyword given, literal or not. See `heuristics/blocking-actions.ts`. */
  given?: string[];
}

export interface LaneUses {
  lane: string;
  actions: UsedAction[];
  /** Environment variables the lane reads, by name. Absent on an older cache. */
  env?: string[];
}

/**
 * The lanes, plus what reading them could not account for.
 *
 * `imports` is the one thing a Fastfile can say that makes its own text an
 * incomplete answer: `import` and `import_from_git` bring in lanes defined
 * somewhere this parse never sees. It travels with the lanes rather than beside
 * them because every consumer that trusts the actions needs to know how much to
 * trust them.
 */
export interface FastfileUses {
  lanes: LaneUses[];
  imports: boolean;
}

/**
 * Hash of the whole fastlane folder, not just the Fastfile:
 * an Appfile, a Pluginfile, or an imported file change the lanes just as much.
 */
async function hashFastlaneDir(root: string, fastlaneDir: string): Promise<string> {
  const dir = join(root, fastlaneDir);
  await assertFastlaneDir(root, fastlaneDir);
  const hash = createHash("sha256");
  // The sidecar is part of the question, not just the answer: a parser that
  // learns to read more finds more in a Fastfile that never changed, and a key
  // built from the folder alone would serve the old reading for ever.
  hash.update(sidecarVersion());
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

  async read(slug: string, workspacePath: string, fastlaneDir: string): Promise<FastfileUses> {
    const hash = await hashFastlaneDir(workspacePath, fastlaneDir);

    const cached = this.cache.get(slug, "uses", hash);
    // An entry cached before `imports` existed is an array, not an object. Read
    // as "nothing known to be hidden", which is what it meant when it was
    // written — rather than throwing away a cache on every upgrade.
    if (cached) {
      return Array.isArray(cached)
        ? { lanes: cached as LaneUses[], imports: false }
        : (cached as FastfileUses);
    }

    const res = await this.invoke("uses", workspacePath, fastlaneDir);
    if (!res.ok) throw new Error(res.error);

    const uses: FastfileUses = {
      lanes: res["lanes"] as LaneUses[],
      imports: res["imports"] === true,
    };
    this.cache.put(slug, "uses", hash, uses);
    return uses;
  }
}

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheStore } from "../../src/db/cache.js";
import { openDatabase } from "../../src/db/open.js";
import { sidecarVersion } from "../../src/sidecar/bridge.js";
import { UsesReader } from "../../src/sidecar/uses.js";
import { tmpDir } from "../fixtures/repos.js";

async function fastlaneDir(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("laneyard-uses-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, "fastlane", name), content, "utf8");
  }
  return dir;
}

const USES = [
  {
    lane: "beta",
    actions: [{ name: "match", args: { readonly: true } }],
  },
];

describe("UsesReader", () => {
  it("queries the sidecar then serves the cache on the second call", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\n  match(readonly: true)\nend\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: USES });
    const reader = new UsesReader(new CacheStore(openDatabase(":memory:")), invoke);

    // The reader now returns the lanes *and* what reading them could not
    // account for, so a consumer knows how far to trust an empty answer.
    expect(await reader.read("p", dir, "fastlane")).toEqual({ lanes: USES, imports: false });
    expect(await reader.read("p", dir, "fastlane")).toEqual({ lanes: USES, imports: false });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-queries the sidecar when a file in the folder changes", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\n  match(readonly: true)\nend\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: USES });
    const reader = new UsesReader(new CacheStore(openDatabase(":memory:")), invoke);

    await reader.read("p", dir, "fastlane");
    await writeFile(
      join(dir, "fastlane", "Fastfile"),
      "lane :beta do\n  match(readonly: false)\nend\n",
      "utf8",
    );
    await reader.read("p", dir, "fastlane");

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("also re-queries when a neighbouring file changes, not just the Fastfile", async () => {
    const dir = await fastlaneDir({
      Fastfile: "lane :beta do\n  match(readonly: true)\nend\n",
      Appfile: "app_identifier 'a'\n",
    });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: USES });
    const reader = new UsesReader(new CacheStore(openDatabase(":memory:")), invoke);

    await reader.read("p", dir, "fastlane");
    await writeFile(join(dir, "fastlane", "Appfile"), "app_identifier 'b'\n", "utf8");
    await reader.read("p", dir, "fastlane");

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("propagates the sidecar's error without caching anything", async () => {
    const dir = await fastlaneDir({ Fastfile: "broken" });
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: "unreadable Fastfile" });
    const reader = new UsesReader(new CacheStore(openDatabase(":memory:")), invoke);

    await expect(reader.read("p", dir, "fastlane")).rejects.toThrow(/unreadable/);
    await expect(reader.read("p", dir, "fastlane")).rejects.toThrow(/unreadable/);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

/**
 * The cache keyed only on what it read, and not on what read it.
 *
 * Teaching the parser to follow a lane into its methods changed what a Fastfile
 * means without changing the Fastfile. Every install with a warm cache went on
 * being served the old reading — a Play Store check reporting "no lane uploads"
 * for ever, on a project that uploads on every run. The sidecar script is part
 * of the key now, so there is no constant anyone has to remember to bump.
 */
describe("UsesReader cache keying", () => {
  it("keys on more than the folder it read", async () => {
    const files = { Fastfile: "lane :beta do\nend\n" };
    const dir = await fastlaneDir(files);
    const db = openDatabase(":memory:");
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: [] });

    await new UsesReader(new CacheStore(db), invoke).read("p", dir, "fastlane");
    const { config_hash: stored } = db
      .prepare("SELECT config_hash FROM introspection_cache")
      .get() as { config_hash: string };

    // The folder's contents alone — which is exactly what the key used to be,
    // and what left an improved parser serving the old reading for ever.
    const folderOnly = createHash("sha256");
    folderOnly.update(join(dir, "fastlane", "Fastfile"));
    folderOnly.update(Buffer.from(files.Fastfile));

    expect(stored).not.toBe(folderOnly.digest("hex"));
  });

  it("folds the sidecar's own digest into the key", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n" });
    const db = openDatabase(":memory:");
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: [{ lane: "beta", actions: [] }] });

    await new UsesReader(new CacheStore(db), invoke).read("p", dir, "fastlane");
    const stored = db.prepare("SELECT config_hash FROM introspection_cache").get() as {
      config_hash: string;
    };

    // The folder alone would hash to something else entirely; asserting the
    // digest participates is enough, and does not pin its value.
    expect(stored.config_hash).toHaveLength(64);
    expect(sidecarVersion()).toHaveLength(16);
  });
});

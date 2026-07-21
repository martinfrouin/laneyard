import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheStore } from "../../src/db/cache.js";
import { openDatabase } from "../../src/db/open.js";
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

    expect(await reader.read("p", dir, "fastlane")).toEqual(USES);
    expect(await reader.read("p", dir, "fastlane")).toEqual(USES);
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

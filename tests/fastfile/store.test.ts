import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FastfileStore } from "../../src/fastfile/store.js";
import type { VerifyResult } from "../../src/fastfile/store.js";
import { tmpDir } from "../fixtures/repos.js";

/** A bare workspace with a `fastlane/Fastfile` already on disk, as a real project would have. */
async function workspace(fastfile: string): Promise<string> {
  const dir = await tmpDir("laneyard-fastfile-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  await writeFile(join(dir, "fastlane", "Fastfile"), fastfile, "utf8");
  return dir;
}

const verifyAlways = async (): Promise<VerifyResult> => ({ ok: true });
const verifyNever = async (): Promise<VerifyResult> => ({
  ok: false,
  reason: "lane :beta was never closed",
});

describe("FastfileStore", () => {
  it("reads the file as it is on disk", async () => {
    const store = new FastfileStore();
    const dir = await workspace("lane :beta do\nend\n");

    expect(await store.read(dir)).toBe("lane :beta do\nend\n");
  });

  it("writes exactly the bytes it was given", async () => {
    const store = new FastfileStore();
    const dir = await workspace("lane :beta do\nend\n");

    // No reformatting, no trailing-newline fixing, no reordering. Someone's
    // comments and indentation are theirs.
    const weird = "lane :beta do\r\n\t# odd but theirs\r\n  end\r\n\r\n";
    await store.write(dir, weird, verifyAlways);

    expect(await store.read(dir)).toBe(weird);
  });

  it("puts the previous content back when verification fails", async () => {
    const store = new FastfileStore();
    const dir = await workspace("lane :beta do\nend\n");
    const before = await store.read(dir);

    const result = await store.write(dir, "lane :beta do  # never closed", verifyNever);

    expect(result.ok).toBe(false);
    expect(await store.read(dir)).toBe(before);
  });

  it("reports why verification failed, in the verifier's own words", async () => {
    const store = new FastfileStore();
    const dir = await workspace("lane :beta do\nend\n");

    const result = await store.write(dir, "lane :beta do  # never closed", verifyNever);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("lane :beta was never closed");
  });

  it("does not touch the file at all when verification succeeds trivially", async () => {
    const store = new FastfileStore();
    const dir = await workspace("lane :beta do\nend\n");

    const result = await store.write(dir, "lane :beta do\n  puts 1\nend\n", verifyAlways);

    expect(result.ok).toBe(true);
    expect(await store.read(dir)).toBe("lane :beta do\n  puts 1\nend\n");
  });

  it("refuses to write outside the fastlane directory", async () => {
    const store = new FastfileStore();
    const dir = await workspace("lane :beta do\nend\n");

    await expect(store.read(dir, "../../../etc/hosts")).rejects.toThrow(/outside/i);
  });

  it("leaves no backup file behind on success", async () => {
    const store = new FastfileStore();
    const dir = await workspace("lane :beta do\nend\n");

    await store.write(dir, "lane :beta do\n  puts 1\nend\n", verifyAlways);

    expect(await readdir(join(dir, "fastlane"))).toEqual(["Fastfile"]);
  });

  it("leaves no backup file behind even when verification fails", async () => {
    const store = new FastfileStore();
    const dir = await workspace("lane :beta do\nend\n");

    await store.write(dir, "lane :beta do  # never closed", verifyNever);

    expect(await readdir(join(dir, "fastlane"))).toEqual(["Fastfile"]);
  });
});

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifacts, guessKind } from "../../src/runner/artifacts.js";
import { tmpDir } from "../fixtures/repos.js";

async function workspaceWith(files: string[]): Promise<string> {
  const dir = await tmpDir("laneyard-art-");
  for (const f of files) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), "content", "utf8");
  }
  return dir;
}

describe("guessKind", () => {
  it("recognizes the common types", () => {
    expect(guessKind("Sample.ipa")).toBe("ipa");
    expect(guessKind("app-release.aab")).toBe("aab");
    expect(guessKind("app.apk")).toBe("apk");
    expect(guessKind("Sample.app.dSYM.zip")).toBe("dsym");
    expect(guessKind("notes.txt")).toBe("other");
  });
});

describe("collectArtifacts", () => {
  it("moves files matching the patterns out of the workspace", async () => {
    const ws = await workspaceWith(["build/Sample.ipa", "build/notes.txt"]);
    const dest = await tmpDir("laneyard-dest-");

    const found = await collectArtifacts(ws, ["build/**/*.ipa"], dest);

    expect(found).toHaveLength(1);
    expect(found[0]!.filename).toBe("Sample.ipa");
    expect(found[0]!.kind).toBe("ipa");
    expect(found[0]!.size).toBeGreaterThan(0);
    expect(await readdir(dest)).toEqual(["Sample.ipa"]);
  });

  it("returns nothing when no pattern is configured", async () => {
    const ws = await workspaceWith(["build/Sample.ipa"]);
    expect(await collectArtifacts(ws, [], await tmpDir())).toEqual([]);
  });

  it("disambiguates two files with the same name", async () => {
    const ws = await workspaceWith(["a/app.apk", "b/app.apk"]);
    const dest = await tmpDir("laneyard-dest-");

    const found = await collectArtifacts(ws, ["**/*.apk"], dest);

    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.filename)).size).toBe(2);
  });

  it("ignores a pattern that matches nothing without failing", async () => {
    const ws = await workspaceWith(["build/Sample.ipa"]);
    expect(await collectArtifacts(ws, ["does-not-exist/**/*.zip"], await tmpDir())).toEqual([]);
  });
});

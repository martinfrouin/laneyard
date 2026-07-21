import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifacts, guessKind } from "../../src/runner/artifacts.js";
import { tmpDir } from "../fixtures/repos.js";

async function workspaceWith(files: string[]): Promise<string> {
  const dir = await tmpDir("laneyard-art-");
  for (const f of files) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), "contenu", "utf8");
  }
  return dir;
}

describe("guessKind", () => {
  it("reconnaît les types courants", () => {
    expect(guessKind("Popotes.ipa")).toBe("ipa");
    expect(guessKind("app-release.aab")).toBe("aab");
    expect(guessKind("app.apk")).toBe("apk");
    expect(guessKind("Popotes.app.dSYM.zip")).toBe("dsym");
    expect(guessKind("notes.txt")).toBe("other");
  });
});

describe("collectArtifacts", () => {
  it("déplace hors du workspace les fichiers correspondant aux motifs", async () => {
    const ws = await workspaceWith(["build/Popotes.ipa", "build/notes.txt"]);
    const dest = await tmpDir("laneyard-dest-");

    const found = await collectArtifacts(ws, ["build/**/*.ipa"], dest);

    expect(found).toHaveLength(1);
    expect(found[0]!.filename).toBe("Popotes.ipa");
    expect(found[0]!.kind).toBe("ipa");
    expect(found[0]!.size).toBeGreaterThan(0);
    expect(await readdir(dest)).toEqual(["Popotes.ipa"]);
  });

  it("ne renvoie rien quand aucun motif n'est configuré", async () => {
    const ws = await workspaceWith(["build/Popotes.ipa"]);
    expect(await collectArtifacts(ws, [], await tmpDir())).toEqual([]);
  });

  it("désambiguïse deux fichiers de même nom", async () => {
    const ws = await workspaceWith(["a/app.apk", "b/app.apk"]);
    const dest = await tmpDir("laneyard-dest-");

    const found = await collectArtifacts(ws, ["**/*.apk"], dest);

    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.filename)).size).toBe(2);
  });

  it("ignore un motif qui ne correspond à rien sans échouer", async () => {
    const ws = await workspaceWith(["build/Popotes.ipa"]);
    expect(await collectArtifacts(ws, ["nexiste/**/*.zip"], await tmpDir())).toEqual([]);
  });
});

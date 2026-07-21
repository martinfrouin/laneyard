import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheStore } from "../../src/db/cache.js";
import { openDatabase } from "../../src/db/open.js";
import { LaneReader } from "../../src/sidecar/lanes.js";
import { tmpDir } from "../fixtures/repos.js";

async function fastlaneDir(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("laneyard-lanes-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, "fastlane", name), content, "utf8");
  }
  return dir;
}

const LANES = [{ name: "beta", platform: "ios", description: "", private: false }];

describe("LaneReader", () => {
  it("interroge le sidecar puis sert le cache au second appel", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: LANES });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    expect(await reader.read("p", dir, "fastlane")).toEqual(LANES);
    expect(await reader.read("p", dir, "fastlane")).toEqual(LANES);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("réinterroge le sidecar quand un fichier du dossier change", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: LANES });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    await reader.read("p", dir, "fastlane");
    await writeFile(join(dir, "fastlane", "Fastfile"), "lane :beta do\n  puts 1\nend\n", "utf8");
    await reader.read("p", dir, "fastlane");

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("réinterroge aussi quand un fichier voisin change, pas seulement le Fastfile", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n", Appfile: "app_identifier 'a'\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: LANES });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    await reader.read("p", dir, "fastlane");
    await writeFile(join(dir, "fastlane", "Appfile"), "app_identifier 'b'\n", "utf8");
    await reader.read("p", dir, "fastlane");

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("propage l'erreur du sidecar sans rien mettre en cache", async () => {
    const dir = await fastlaneDir({ Fastfile: "cassé" });
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: "Fastfile illisible" });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    await expect(reader.read("p", dir, "fastlane")).rejects.toThrow(/illisible/);
    await expect(reader.read("p", dir, "fastlane")).rejects.toThrow(/illisible/);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

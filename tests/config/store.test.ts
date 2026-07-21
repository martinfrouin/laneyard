import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { tmpDir } from "../fixtures/repos.js";

const CONFIG = (slug: string) => `
server: { password_hash: "x" }
projects:
  - slug: ${slug}
    git_url: u
`;

async function configFile(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-store-");
  const path = join(dir, "config.yml");
  await writeFile(path, content, "utf8");
  return path;
}

describe("ConfigStore", () => {
  it("charge la configuration au démarrage", async () => {
    const store = new ConfigStore(await configFile(CONFIG("popotes")));
    await store.load();
    expect(store.projects().map((p) => p.slug)).toEqual(["popotes"]);
  });

  it("retrouve un projet par son slug", async () => {
    const store = new ConfigStore(await configFile(CONFIG("popotes")));
    await store.load();
    expect(store.project("popotes")?.git_url).toBe("u");
    expect(store.project("inconnu")).toBeNull();
  });

  it("prend en compte une modification du fichier", async () => {
    const path = await configFile(CONFIG("un"));
    const store = new ConfigStore(path);
    await store.load();

    await writeFile(path, CONFIG("deux"), "utf8");
    await store.load();

    expect(store.projects().map((p) => p.slug)).toEqual(["deux"]);
  });

  it("conserve la dernière configuration valide si le fichier devient invalide", async () => {
    const path = await configFile(CONFIG("un"));
    const store = new ConfigStore(path);
    await store.load();

    await writeFile(path, "projects: [", "utf8");
    const res = await store.load();

    expect(res.ok).toBe(false);
    expect(store.projects().map((p) => p.slug)).toEqual(["un"]);
    expect(store.lastError()).not.toBeNull();
  });

  it("efface l'erreur quand le fichier redevient valide", async () => {
    const path = await configFile(CONFIG("un"));
    const store = new ConfigStore(path);
    await store.load();
    await writeFile(path, "projects: [", "utf8");
    await store.load();

    await writeFile(path, CONFIG("un"), "utf8");
    await store.load();

    expect(store.lastError()).toBeNull();
  });
});

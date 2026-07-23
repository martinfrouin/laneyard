import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { tmpDir } from "../fixtures/repos.js";

const CONFIG = (slug: string) => `
server: { users: [{ name: admin, role: admin, password_hash: "x" }] }
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
  it("loads the configuration at startup", async () => {
    const store = new ConfigStore(await configFile(CONFIG("sample")));
    await store.load();
    expect(store.projects().map((p) => p.slug)).toEqual(["sample"]);
  });

  it("finds a project by its slug", async () => {
    const store = new ConfigStore(await configFile(CONFIG("sample")));
    await store.load();
    expect(store.project("sample")?.git_url).toBe("u");
    expect(store.project("unknown")).toBeNull();
  });

  it("takes a file change into account", async () => {
    const path = await configFile(CONFIG("one"));
    const store = new ConfigStore(path);
    await store.load();

    await writeFile(path, CONFIG("two"), "utf8");
    await store.load();

    expect(store.projects().map((p) => p.slug)).toEqual(["two"]);
  });

  it("keeps the last valid configuration if the file becomes invalid", async () => {
    const path = await configFile(CONFIG("one"));
    const store = new ConfigStore(path);
    await store.load();

    await writeFile(path, "projects: [", "utf8");
    const res = await store.load();

    expect(res.ok).toBe(false);
    expect(store.projects().map((p) => p.slug)).toEqual(["one"]);
    expect(store.lastError()).not.toBeNull();
  });

  it("clears the error once the file becomes valid again", async () => {
    const path = await configFile(CONFIG("one"));
    const store = new ConfigStore(path);
    await store.load();
    await writeFile(path, "projects: [", "utf8");
    await store.load();

    await writeFile(path, CONFIG("one"), "utf8");
    await store.load();

    expect(store.lastError()).toBeNull();
  });
});

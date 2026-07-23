import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** Writes a set of `path -> content` files under a fresh workspace directory. */
async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("laneyard-ws-");
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

async function storeFor(config: string): Promise<ConfigStore> {
  const store = new ConfigStore(await configFile(config));
  await store.load();
  return store;
}

describe("ConfigStore.resolve — where laneyard.yml lives", () => {
  it("reads an app-level file and normalises its paths to repo-root-relative", async () => {
    // The project's fastlane_dir in config.yml anchors the app at `app/`, so the
    // file is read from `app/laneyard.yml` and its app-relative `**/*.aab`
    // becomes `app/**/*.aab` — exactly what a root file with `app/**/*.aab` would
    // have handed downstream.
    const store = await storeFor(`
server: { users: [{ name: admin, role: admin, password_hash: "x" }] }
projects:
  - slug: app
    git_url: u
    fastlane_dir: app/fastlane
`);
    const ws = await workspace({ "app/laneyard.yml": "artifact_globs:\n  - '**/*.aab'\n" });

    const r = await store.resolve("app", ws);
    expect(r!.settings.artifact_globs).toEqual(["app/**/*.aab"]);
    expect(r!.provenance.artifact_globs).toBe("repo");
  });

  it("keeps two apps on one remote from seeing each other's settings", async () => {
    const store = await storeFor(`
server: { users: [{ name: admin, role: admin, password_hash: "x" }] }
projects:
  - slug: app1
    git_url: u
    fastlane_dir: app1/fastlane
  - slug: app2
    git_url: u
    fastlane_dir: app2/fastlane
`);
    const ws = await workspace({
      "app1/laneyard.yml": "artifact_globs:\n  - '**/*.aab'\n",
      "app2/laneyard.yml": "artifact_globs:\n  - '**/*.ipa'\n",
    });

    const r1 = await store.resolve("app1", ws);
    const r2 = await store.resolve("app2", ws);
    expect(r1!.settings.artifact_globs).toEqual(["app1/**/*.aab"]);
    expect(r2!.settings.artifact_globs).toEqual(["app2/**/*.ipa"]);
  });

  it("lets an app-level file win over config.yml for a refined setting", async () => {
    const store = await storeFor(`
server: { users: [{ name: admin, role: admin, password_hash: "x" }] }
projects:
  - slug: app
    git_url: u
    fastlane_dir: app/fastlane
    runtime: system
`);
    const ws = await workspace({ "app/laneyard.yml": "runtime: bundle\n" });

    const r = await store.resolve("app", ws);
    expect(r!.settings.runtime).toBe("bundle");
    expect(r!.provenance.runtime).toBe("repo");
  });

  it("still loads a root laneyard.yml unchanged when there is no app-level file", async () => {
    // No fastlane_dir in config.yml: the app root is the repository root, the two
    // locations coincide, and the root file's paths are read as-is.
    const store = await storeFor(CONFIG("app"));
    const ws = await workspace({ "laneyard.yml": "artifact_globs:\n  - 'build/*.ipa'\n" });

    const r = await store.resolve("app", ws);
    expect(r!.settings.artifact_globs).toEqual(["build/*.ipa"]);
    expect(r!.provenance.artifact_globs).toBe("repo");
  });

  it("falls back to the root file, unnormalised, when the app dir has none", async () => {
    // The app is anchored at `app/`, but only a repository-root file exists. It
    // is back-compatible: its paths are already repo-root-relative and are not
    // prefixed.
    const store = await storeFor(`
server: { users: [{ name: admin, role: admin, password_hash: "x" }] }
projects:
  - slug: app
    git_url: u
    fastlane_dir: app/fastlane
`);
    const ws = await workspace({ "laneyard.yml": "artifact_globs:\n  - 'app/**/*.aab'\n" });

    const r = await store.resolve("app", ws);
    expect(r!.settings.artifact_globs).toEqual(["app/**/*.aab"]);
  });
});

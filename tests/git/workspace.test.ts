import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../../src/git/workspace.js";
import { commitTo, makeOriginRepo, tmpDir } from "../fixtures/repos.js";

describe("Workspace", () => {
  it("clones on first access then declares itself ready", async () => {
    const origin = await makeOriginRepo({ "README.md": "hello" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);

    expect(await ws.exists()).toBe(false);
    await ws.prepare("main");
    expect(await ws.exists()).toBe(true);
    expect(await readFile(join(ws.path, "README.md"), "utf8")).toBe("hello");
  }, 30_000);

  it("fetches new commits on the next run", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");

    const sha = await commitTo(origin, "a.txt", "v2");
    await ws.prepare("main");

    expect(await readFile(join(ws.path, "a.txt"), "utf8")).toBe("v2");
    expect(await ws.headSha()).toBe(sha);
  }, 30_000);

  it("refuses to prepare over uncommitted changes", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");
    await writeFile(join(ws.path, "a.txt"), "edited by hand", "utf8");

    expect(await ws.isDirty()).toBe(true);
    await expect(ws.prepare("main")).rejects.toThrow(/uncommitted/i);
  }, 30_000);

  it("doesn't declare itself dirty for untracked files left by a build", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");

    // What a real run produces: fastlane rewrites its README, the build outputs a binary.
    await writeFile(join(ws.path, "README-fastlane.md"), "generated", "utf8");

    expect(await ws.isDirty()).toBe(false);
    // And the next run must be able to prepare the workspace.
    await expect(ws.prepare("main")).resolves.toMatch(/^[0-9a-f]{40}$/);
  }, 30_000);

  it("fails readably on an unknown branch", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await expect(ws.prepare("does-not-exist")).rejects.toThrow(/does-not-exist/);
  }, 30_000);

  it("clones on demand without switching branch", async () => {
    const origin = await makeOriginRepo({ "laneyard.yml": "runtime: system\n" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);

    await ws.ensureCloned();
    expect(await ws.exists()).toBe(true);

    // Idempotent: a second call redoes nothing and doesn't throw.
    await ws.ensureCloned();
    expect(await ws.exists()).toBe(true);
  }, 30_000);

  it("never copies the repository URL into an error message", async () => {
    // An HTTPS URL can carry a token; these messages end up in the run's log.
    const secret = "https://user:ghp_TRESSECRET@example.invalid/m/demo.git";
    const ws = new Workspace(join(await tmpDir(), "p"), secret);

    await expect(ws.prepare("main")).rejects.toThrow();
    await ws.prepare("main").catch((err: Error) => {
      expect(err.message).not.toContain("ghp_TRESSECRET");
      expect(err.message).toContain("<repository>");
    });
  }, 30_000);
});

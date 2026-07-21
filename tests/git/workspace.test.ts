import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Workspace } from "../../src/git/workspace.js";
import { commitTo, makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const exec = promisify(execFile);

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

  describe("status", () => {
    it("reports tracked paths with uncommitted changes, not untracked ones", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1", "b.txt": "v1" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");

      await writeFile(join(ws.path, "a.txt"), "edited", "utf8");
      // What a build leaves behind: untracked, and not part of the answer.
      await writeFile(join(ws.path, "generated.txt"), "generated", "utf8");

      expect(await ws.status()).toEqual(["a.txt"]);
    }, 30_000);

    it("reports no changes on a clean workspace", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");

      expect(await ws.status()).toEqual([]);
    }, 30_000);
  });

  describe("diff", () => {
    it("returns the unified diff of a given path", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1\n" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");
      await writeFile(join(ws.path, "a.txt"), "v2\n", "utf8");

      const diff = await ws.diff("a.txt");
      expect(diff).toContain("-v1");
      expect(diff).toContain("+v2");
    }, 30_000);

    it("returns the diff of the whole workspace with no path given", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1\n", "b.txt": "v1\n" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");
      await writeFile(join(ws.path, "a.txt"), "v2\n", "utf8");
      await writeFile(join(ws.path, "b.txt"), "v2\n", "utf8");

      const diff = await ws.diff();
      expect(diff).toContain("a.txt");
      expect(diff).toContain("b.txt");
    }, 30_000);

    it("returns an empty diff for an unchanged workspace", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1\n" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");

      expect(await ws.diff()).toBe("");
    }, 30_000);
  });

  describe("commit", () => {
    it("stages exactly the given paths, never everything in the workspace", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");

      await writeFile(join(ws.path, "a.txt"), "v2", "utf8");
      // Left by a build; committing it because it happened to be there is
      // exactly what this wrapper must never do.
      await writeFile(join(ws.path, "generated.txt"), "not meant to be committed", "utf8");

      await ws.commit("edit a.txt", ["a.txt"]);

      const { stdout } = await exec(
        "git",
        ["show", "--name-only", "--pretty=format:", "HEAD"],
        { cwd: ws.path },
      );
      expect(stdout.trim().split("\n")).toEqual(["a.txt"]);
      // The build artifact is still sitting there, untracked.
      expect(await ws.status()).toEqual([]);
    }, 30_000);

    it("refuses to commit with no paths given", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");

      await expect(ws.commit("nothing", [])).rejects.toThrow();
    }, 30_000);

    it("commits using the repository's own identity when it has one", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");
      await exec("git", ["config", "user.name", "Repo Owner"], { cwd: ws.path });
      await exec("git", ["config", "user.email", "owner@example.com"], { cwd: ws.path });

      await writeFile(join(ws.path, "a.txt"), "v2", "utf8");
      const { author } = await ws.commit("edit a.txt", ["a.txt"]);

      expect(author).toBe("Repo Owner <owner@example.com>");
      const { stdout } = await exec("git", ["log", "-1", "--pretty=%an <%ae>"], { cwd: ws.path });
      expect(stdout.trim()).toBe("Repo Owner <owner@example.com>");
    }, 30_000);

    it("commits as Laneyard, and says so, when the repository has no identity of its own", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");

      // Isolated from whatever git identity happens to be configured
      // globally on the machine running this test, so the fallback path is
      // exercised regardless of environment.
      const prevGlobal = process.env["GIT_CONFIG_GLOBAL"];
      const prevNoSystem = process.env["GIT_CONFIG_NOSYSTEM"];
      process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
      process.env["GIT_CONFIG_NOSYSTEM"] = "1";
      try {
        await writeFile(join(ws.path, "a.txt"), "v2", "utf8");
        const { author } = await ws.commit("edit a.txt", ["a.txt"]);
        expect(author).toBe("Laneyard <laneyard@localhost>");

        const { stdout } = await exec("git", ["log", "-1", "--pretty=%an <%ae>"], { cwd: ws.path });
        expect(stdout.trim()).toBe("Laneyard <laneyard@localhost>");
      } finally {
        if (prevGlobal === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
        else process.env["GIT_CONFIG_GLOBAL"] = prevGlobal;
        if (prevNoSystem === undefined) delete process.env["GIT_CONFIG_NOSYSTEM"];
        else process.env["GIT_CONFIG_NOSYSTEM"] = prevNoSystem;
      }
    }, 30_000);
  });

  describe("push", () => {
    it("pushes local commits to the remote", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1" });
      // The fixture "remote" is a normal, non-bare repository with `main`
      // checked out: by default git refuses any push to a checked-out branch
      // at all, fast-forward or not. Real remotes are bare and don't have
      // this restriction; this only accommodates the test double.
      await exec("git", ["config", "receive.denyCurrentBranch", "updateInstead"], { cwd: origin });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");

      await writeFile(join(ws.path, "a.txt"), "v2", "utf8");
      await ws.commit("edit a.txt", ["a.txt"]);
      await ws.push("main");

      const check = new Workspace(join(await tmpDir(), "check"), origin);
      await check.ensureCloned();
      expect(await readFile(join(check.path, "a.txt"), "utf8")).toBe("v2");
    }, 30_000);

    it("returns git's own message when the push is rejected", async () => {
      const origin = await makeOriginRepo({ "a.txt": "v1" });
      const ws = new Workspace(join(await tmpDir(), "p"), origin);
      await ws.prepare("main");

      // Someone else pushes to the remote in the meantime; ws hasn't fetched
      // it, so its own push is now behind.
      await commitTo(origin, "a.txt", "v2-from-elsewhere");

      await writeFile(join(ws.path, "b.txt"), "new file", "utf8");
      await ws.commit("add b.txt", ["b.txt"]);

      await expect(ws.push("main")).rejects.toThrow(/rejected|fetch first/i);
    }, 30_000);
  });
});

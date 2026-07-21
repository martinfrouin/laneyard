import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../../src/cli/detect.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

async function projectDir(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("laneyard-detect-");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

describe("detectProject", () => {
  it("finds the fastlane folder at the root", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "lane :beta do\nend\n" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBe("fastlane");
  });

  it("finds a fastlane folder nested in a monorepo", async () => {
    const dir = await projectDir({ "apps/ios/fastlane/Fastfile": "lane :beta do\nend\n" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBe("apps/ios/fastlane");
  });

  it("reports the absence of fastlane rather than guessing", async () => {
    const dir = await projectDir({ "README.md": "nothing" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBeNull();
  });

  it("chooses bundle when a Gemfile is present, system otherwise", async () => {
    const withGemfile = await projectDir({ "fastlane/Fastfile": "", Gemfile: 'gem "fastlane"' });
    expect((await detectProject(withGemfile)).runtime).toBe("bundle");

    const without = await projectDir({ "fastlane/Fastfile": "" });
    expect((await detectProject(without)).runtime).toBe("system");
  });

  it("proposes iOS artifact patterns on an Xcode project", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "", "Sample.xcodeproj/project.pbxproj": "" });
    const d = await detectProject(dir);
    expect(d.artifactGlobs).toContain("**/*.ipa");
    expect(d.artifactGlobs.some((g) => g.includes("dSYM"))).toBe(true);
  });

  it("proposes Android patterns on a Gradle project", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "", "app/build.gradle": "" });
    const d = await detectProject(dir);
    expect(d.artifactGlobs).toContain("**/*.apk");
    expect(d.artifactGlobs).toContain("**/*.aab");
  });

  it("reports the platforms it found, so setup can write them down", async () => {
    const ios = await projectDir({ "fastlane/Fastfile": "", "Sample.xcodeproj/project.pbxproj": "" });
    expect((await detectProject(ios)).platforms).toEqual(["ios"]);

    const android = await projectDir({ "fastlane/Fastfile": "", "app/build.gradle": "" });
    expect((await detectProject(android)).platforms).toEqual(["android"]);

    const dual = await projectDir({
      "fastlane/Fastfile": "",
      "Sample.xcodeproj/project.pbxproj": "",
      "android/build.gradle": "",
    });
    expect((await detectProject(dual)).platforms).toEqual(["ios", "android"]);

    const neither = await projectDir({ "fastlane/Fastfile": "" });
    expect((await detectProject(neither)).platforms).toEqual([]);
  });

  it("reads the remote's URL and the current branch", async () => {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "" });
    const clone = await tmpDir("laneyard-clone-");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["clone", origin, clone]);

    const d = await detectProject(clone);
    expect(d.gitUrl).toBe(origin);
    expect(d.defaultBranch).toBe("main");
    // A real git clone, like the rest of the suite's git-backed tests: the
    // default 5s budget is tight once the whole suite runs its git commands
    // concurrently.
  }, 30_000);

  it("derives a slug from the folder name", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "" });
    const d = await detectProject(dir);
    expect(d.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe("detectProject in a sub-directory of a repository", () => {
  /** A monorepo whose app lives under `app/`, as many do. */
  async function monorepo(): Promise<{ root: string; app: string }> {
    const root = await tmpDir("laneyard-mono-");
    await mkdir(join(root, "app", "fastlane"), { recursive: true });
    await writeFile(join(root, "app", "fastlane", "Fastfile"), "lane :beta do\nend\n", "utf8");
    await mkdir(join(root, "app", "App.xcodeproj"), { recursive: true });
    await writeFile(join(root, "app", "App.xcodeproj", "project.pbxproj"), "", "utf8");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q", "-b", "main"], { cwd: root });
    await run("git", ["remote", "add", "origin", "git@example.com:you/monorepo.git"], { cwd: root });

    return { root, app: join(root, "app") };
  }

  it("reports the fastlane directory relative to the repository, not the cwd", async () => {
    // Laneyard clones the repository, so a path measured from the current
    // directory points nowhere in the workspace. This is the bug that shipped.
    const { app } = await monorepo();
    const d = await detectProject(app);
    expect(d.fastlaneDir).toBe("app/fastlane");
  });

  it("anchors artifact patterns to the sub-project", async () => {
    // Unanchored, `**/*.ipa` would collect a sibling app's build as if it were
    // this one's, and nothing downstream would notice.
    const { app } = await monorepo();
    const d = await detectProject(app);
    expect(d.artifactGlobs).toContain("app/**/*.ipa");
    expect(d.artifactGlobs).not.toContain("**/*.ipa");
  });

  it("names the slug after the repository and the sub-project", async () => {
    // Two apps in one monorepo cannot both be called `app`.
    const { app } = await monorepo();
    expect((await detectProject(app)).slug).toBe("monorepo-app");
  });

  it("reports where the command was run", async () => {
    const { root, app } = await monorepo();
    expect((await detectProject(app)).subPath).toBe("app");
    expect((await detectProject(root)).subPath).toBe("");
  });

  it("keeps root-level projects unprefixed", async () => {
    const { root } = await monorepo();
    const d = await detectProject(root);
    expect(d.fastlaneDir).toBe("app/fastlane");
    expect(d.slug).toBe("monorepo");
  });
});

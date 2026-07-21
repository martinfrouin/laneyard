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
    const dir = await projectDir({ "fastlane/Fastfile": "", "Popotes.xcodeproj/project.pbxproj": "" });
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

  it("reads the remote's URL and the current branch", async () => {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "" });
    const clone = await tmpDir("laneyard-clone-");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["clone", origin, clone]);

    const d = await detectProject(clone);
    expect(d.gitUrl).toBe(origin);
    expect(d.defaultBranch).toBe("main");
  });

  it("derives a slug from the folder name", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "" });
    const d = await detectProject(dir);
    expect(d.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

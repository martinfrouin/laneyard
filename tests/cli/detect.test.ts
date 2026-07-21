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
  it("trouve le dossier fastlane à la racine", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "lane :beta do\nend\n" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBe("fastlane");
  });

  it("trouve un dossier fastlane imbriqué dans un monorepo", async () => {
    const dir = await projectDir({ "apps/ios/fastlane/Fastfile": "lane :beta do\nend\n" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBe("apps/ios/fastlane");
  });

  it("signale l'absence de fastlane plutôt que de deviner", async () => {
    const dir = await projectDir({ "README.md": "rien" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBeNull();
  });

  it("choisit bundle quand un Gemfile est présent, system sinon", async () => {
    const avec = await projectDir({ "fastlane/Fastfile": "", Gemfile: 'gem "fastlane"' });
    expect((await detectProject(avec)).runtime).toBe("bundle");

    const sans = await projectDir({ "fastlane/Fastfile": "" });
    expect((await detectProject(sans)).runtime).toBe("system");
  });

  it("propose des motifs d'artefacts iOS sur un projet Xcode", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "", "Popotes.xcodeproj/project.pbxproj": "" });
    const d = await detectProject(dir);
    expect(d.artifactGlobs).toContain("**/*.ipa");
    expect(d.artifactGlobs.some((g) => g.includes("dSYM"))).toBe(true);
  });

  it("propose des motifs Android sur un projet Gradle", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "", "app/build.gradle": "" });
    const d = await detectProject(dir);
    expect(d.artifactGlobs).toContain("**/*.apk");
    expect(d.artifactGlobs).toContain("**/*.aab");
  });

  it("lit l'URL du distant et la branche courante", async () => {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "" });
    const clone = await tmpDir("laneyard-clone-");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["clone", origin, clone]);

    const d = await detectProject(clone);
    expect(d.gitUrl).toBe(origin);
    expect(d.defaultBranch).toBe("main");
  });

  it("déduit un slug du nom de dossier", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "" });
    const d = await detectProject(dir);
    expect(d.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addProjectToConfig } from "../../src/cli/add.js";
import { tmpDir } from "../fixtures/repos.js";

const EXISTING = `# My Laneyard configuration
server:
  port: 7890
  password_hash: "scrypt$a$b"   # server password

projects:
  - slug: deja-la
    git_url: git@example.com:a.git
`;

async function configAt(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-add-");
  const path = join(dir, "config.yml");
  await writeFile(path, content, "utf8");
  return path;
}

const entry = {
  slug: "sample-ios",
  name: "Sample iOS",
  git_url: "git@example.com:sample.git",
  default_branch: "main",
  fastlane_dir: "fastlane",
  runtime: "system" as const,
  artifact_globs: ["**/*.ipa"],
};

describe("addProjectToConfig", () => {
  it("adds the project without removing existing projects", async () => {
    const path = await configAt(EXISTING);
    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as { projects: { slug: string }[] };
    expect(parsed.projects.map((p) => p.slug)).toEqual(["deja-la", "sample-ios"]);
  });

  it("preserves the file's comments", async () => {
    const path = await configAt(EXISTING);
    await addProjectToConfig(path, entry);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("# My Laneyard configuration");
    expect(raw).toContain("# server password");
  });

  it("refuses an already-taken slug", async () => {
    const path = await configAt(EXISTING);
    await expect(addProjectToConfig(path, { ...entry, slug: "deja-la" })).rejects.toThrow(/deja-la/);
  });

  it("creates the file and the server section if they don't exist", async () => {
    const dir = await tmpDir("laneyard-add-");
    const path = join(dir, "config.yml");

    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as {
      server: { password_hash: string };
      projects: unknown[];
    };
    expect(parsed.projects).toHaveLength(1);
    // A password must exist, otherwise the server would refuse every connection.
    expect(parsed.server.password_hash).toMatch(/^scrypt\$/);
  });

  it("adds a projects section missing from an existing file", async () => {
    const path = await configAt('server:\n  password_hash: "scrypt$a$b"\n');
    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as { projects: unknown[] };
    expect(parsed.projects).toHaveLength(1);
  });
});

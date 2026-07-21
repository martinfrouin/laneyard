import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addProjectToConfig, runSetupCommand } from "../../src/cli/setup.js";
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

describe("runSetupCommand", () => {
  /** A repository whose app lives in a sub-directory, like most monorepos. */
  async function monorepo(): Promise<{ root: string; app: string; configPath: string }> {
    const root = await tmpDir("laneyard-add-mono-");
    await mkdir(join(root, "app", "fastlane"), { recursive: true });
    await writeFile(join(root, "app", "fastlane", "Fastfile"), "lane :beta do\nend\n", "utf8");
    // An Xcode project, so artifact patterns are detected — without one there is
    // nothing to detect and the test would assert against an empty list.
    await mkdir(join(root, "app", "App.xcodeproj"), { recursive: true });
    await writeFile(join(root, "app", "App.xcodeproj", "project.pbxproj"), "", "utf8");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q", "-b", "main"], { cwd: root });
    await run("git", ["remote", "add", "origin", "git@example.com:you/popotheque.git"], { cwd: root });

    return { root, app: join(root, "app"), configPath: join(await tmpDir(), "config.yml") };
  }

  it("writes build behaviour into the repository, where it can be committed", async () => {
    // Two bugs in one place. The path used to be measured from the current
    // directory — run from `app/`, it was written as `fastlane` while the clone
    // holds it at `app/fastlane`, and the lane list failed with ENOENT far from
    // its cause. And it went into the machine's config.yml, so it was never
    // versioned and a colleague cloning the repository got nothing.
    const { app, root, configPath } = await monorepo();
    expect(await runSetupCommand(app, configPath, { yes: true })).toBe(0);

    const repoConfig = parse(await readFile(join(root, "laneyard.yml"), "utf8")) as {
      fastlane_dir: string;
      runtime: string;
      artifact_globs: string[];
    };
    expect(repoConfig.fastlane_dir).toBe("app/fastlane");
    expect(repoConfig.artifact_globs).toContain("app/**/*.ipa");
  });

  it("writes down the platforms it detected, so nothing re-infers them later", async () => {
    // Inferred once and written down, the value can be corrected by hand.
    // Re-inferred on every check, it cannot — and the checklist and setup
    // would be free to disagree about the same repository.
    const { app, root, configPath } = await monorepo();
    await runSetupCommand(app, configPath, { yes: true });

    const repoConfig = parse(await readFile(join(root, "laneyard.yml"), "utf8")) as {
      platforms: string[];
    };
    expect(repoConfig.platforms).toEqual(["ios"]);
  });

  it("keeps the machine's file to how the project is reached", async () => {
    const { app, configPath } = await monorepo();
    await runSetupCommand(app, configPath, { yes: true });

    const written = parse(await readFile(configPath, "utf8")) as {
      projects: Record<string, unknown>[];
    };
    expect(written.projects[0]).toHaveProperty("git_url");
    // Build behaviour belongs in the repository, not here.
    expect(written.projects[0]).not.toHaveProperty("fastlane_dir");
  });

  it("leaves an existing laneyard.yml alone", async () => {
    // Someone put it there, possibly with comments and choices this command
    // knows nothing about — and its values win anyway.
    const { app, root, configPath } = await monorepo();
    await writeFile(join(root, "laneyard.yml"), "# mine\nruntime: bundle\n", "utf8");

    await runSetupCommand(app, configPath, { yes: true });

    expect(await readFile(join(root, "laneyard.yml"), "utf8")).toBe("# mine\nruntime: bundle\n");
  });

  it("names the project after the repository and the sub-directory", async () => {
    const { app, configPath } = await monorepo();
    await runSetupCommand(app, configPath, { yes: true });

    const written = parse(await readFile(configPath, "utf8")) as { projects: { slug: string }[] };
    expect(written.projects[0]!.slug).toBe("popotheque-app");
  });

  it("takes what the user types over what it guessed", async () => {
    const { app, configPath } = await monorepo();
    const answers = ["chosen-name", "", "develop", "", "", ""];
    let i = 0;

    await runSetupCommand(app, configPath, {
      asker: {
        ask: async (_label, proposed) => answers[i++] || proposed,
        confirm: async () => true,
        close: () => {},
      },
    });

    const written = parse(await readFile(configPath, "utf8")) as {
      projects: { slug: string; default_branch: string }[];
    };
    expect(written.projects[0]!.slug).toBe("chosen-name");
    expect(written.projects[0]!.default_branch).toBe("develop");
  });

  it("writes nothing when the user declines", async () => {
    const { app, configPath } = await monorepo();
    const code = await runSetupCommand(app, configPath, {
      asker: {
        ask: async (_l, proposed) => proposed,
        confirm: async () => false,
        close: () => {},
      },
    });

    expect(code).toBe(0);
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });
});

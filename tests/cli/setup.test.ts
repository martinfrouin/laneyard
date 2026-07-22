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

  /**
   * Setup prints "Continuing updates its entry" before asking anything, and
   * this used to throw instead — so running setup again, the one way to correct
   * an entry written by an older version, was the one thing that could not be
   * done. The refusal was the stale half.
   */
  it("updates an entry of the same name instead of refusing", async () => {
    const path = await configAt(EXISTING);
    await addProjectToConfig(path, { ...entry, slug: "deja-la", default_branch: "develop" });

    const written = parse(await readFile(path, "utf8")) as {
      projects: Record<string, unknown>[];
    };
    expect(written.projects).toHaveLength(1);
    expect(written.projects[0]!["default_branch"]).toBe("develop");
  });

  it("leaves alone what the entry carried and setup knows nothing about", async () => {
    const path = await configAt(EXISTING);
    const doc = await readFile(path, "utf8");
    await writeFile(
      path,
      doc.replace(
        "slug: deja-la",
        "slug: deja-la\n    timeout_minutes: 120\n    git_auth: { kind: ssh_key, ref: /keys/id }",
      ),
      "utf8",
    );

    await addProjectToConfig(path, { ...entry, slug: "deja-la" });

    const written = parse(await readFile(path, "utf8")) as {
      projects: Record<string, unknown>[];
    };
    expect(written.projects[0]!["timeout_minutes"]).toBe(120);
    expect(written.projects[0]!["git_auth"]).toEqual({ kind: "ssh_key", ref: "/keys/id" });
  });

  it("creates the file if it doesn't exist", async () => {
    const dir = await tmpDir("laneyard-add-");
    const path = join(dir, "config.yml");

    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as { projects: unknown[] };
    expect(parsed.projects).toHaveLength(1);
  });

  it("invents no account — that is not this function's business", async () => {
    // It used to write a `password_hash` on the way past, which meant
    // registering a project could quietly create the legacy single-password
    // form on a machine that was about to be given named accounts.
    const dir = await tmpDir("laneyard-add-");
    const path = join(dir, "config.yml");

    await addProjectToConfig(path, entry);

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("password_hash");
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

  /** The ordinary shape: fastlane at the root, which needs no machine-side note. */
  async function repoWithFastlaneAtRoot(): Promise<{ app: string; configPath: string }> {
    const root = await tmpDir("laneyard-add-root-");
    await mkdir(join(root, "fastlane"), { recursive: true });
    await writeFile(join(root, "fastlane", "Fastfile"), "lane :beta do\nend\n", "utf8");
    await mkdir(join(root, "App.xcodeproj"), { recursive: true });
    await writeFile(join(root, "App.xcodeproj", "project.pbxproj"), "", "utf8");
    // A Gemfile, so `bundle` is detected — which is the default, and therefore
    // the case where the machine's file has nothing to say.
    await writeFile(join(root, "Gemfile"), 'gem "fastlane"\n', "utf8");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q", "-b", "main"], { cwd: root });
    await run("git", ["remote", "add", "origin", "git@example.com:you/plain.git"], { cwd: root });

    return { app: root, configPath: join(await tmpDir(), "config.yml") };
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

  /**
   * The repository is authoritative about how a project builds — but Laneyard
   * builds from a clone of the remote, so `laneyard.yml` says nothing until it
   * is committed and pushed. Between the end of setup and that push, a project
   * whose fastlane folder is not at the root was simply unreadable, and said so
   * with an ENOENT.
   *
   * So the one field needed to *find* the Fastfile is kept on this machine too,
   * and only when it is not already the default. `laneyard.yml` still wins the
   * moment it lands: this is the precedence config.yml documents, not a second
   * source of truth.
   */
  it("keeps the machine's file to how the project is reached, plus what it takes to read it", async () => {
    const { app, configPath } = await monorepo();
    await runSetupCommand(app, configPath, { yes: true });

    const written = parse(await readFile(configPath, "utf8")) as {
      projects: Record<string, unknown>[];
    };
    expect(written.projects[0]).toHaveProperty("git_url");
    // The two the sidecar needs before it can read anything at all.
    expect(written.projects[0]!["fastlane_dir"]).toBe("app/fastlane");
    expect(written.projects[0]!["runtime"]).toBe("system");
    // The rest of build behaviour stays in the repository.
    expect(written.projects[0]).not.toHaveProperty("artifact_globs");
    expect(written.projects[0]).not.toHaveProperty("platforms");
    expect(written.projects[0]).not.toHaveProperty("timeout_minutes");
  });

  it("says nothing about either when they are the usual ones", async () => {
    const { app, configPath } = await repoWithFastlaneAtRoot();
    await runSetupCommand(app, configPath, { yes: true });

    const written = parse(await readFile(configPath, "utf8")) as {
      projects: Record<string, unknown>[];
    };
    expect(written.projects[0]).not.toHaveProperty("fastlane_dir");
    expect(written.projects[0]).not.toHaveProperty("runtime");
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
    // The first question is the admin's name, because this machine has none yet.
    const answers = ["", "chosen-name", "", "develop", "", "", ""];
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

  it("creates the first admin, in the users form and never a bare password_hash", async () => {
    // A bare `password_hash` beside `users` is the one combination the loader
    // refuses. Writing the legacy shape on a fresh machine would mean every new
    // installation needs migrating the first time someone adds a colleague.
    const { app, configPath } = await monorepo();
    await runSetupCommand(app, configPath, { yes: true });

    const written = parse(await readFile(configPath, "utf8")) as {
      server: { password_hash?: string; users: { name: string; role: string; password_hash: string }[] };
    };
    expect(written.server.password_hash).toBeUndefined();
    expect(written.server.users).toHaveLength(1);
    expect(written.server.users[0]!.role).toBe("admin");
    expect(written.server.users[0]!.password_hash).toMatch(/^scrypt\$/);
  });

  it("asks what to call that first account", async () => {
    const { app, configPath } = await monorepo();
    await runSetupCommand(app, configPath, {
      asker: {
        ask: async (label, proposed) => (label.includes("signing in") ? "martin" : proposed),
        confirm: async () => true,
        close: () => {},
      },
    });

    const written = parse(await readFile(configPath, "utf8")) as {
      server: { users: { name: string }[] };
    };
    expect(written.server.users[0]!.name).toBe("martin");
  });

  it("leaves the accounts of a machine that already has some alone", async () => {
    const { app, configPath } = await monorepo();
    await writeFile(configPath, 'server:\n  password_hash: "scrypt$a$b"\n', "utf8");

    await runSetupCommand(app, configPath, { yes: true });

    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain('password_hash: "scrypt$a$b"');
    expect(raw).not.toContain("users:");
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

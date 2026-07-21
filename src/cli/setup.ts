import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Document, parseDocument, YAMLSeq } from "yaml";
import { loadServerConfig } from "../config/load.js";
import { hashPassword } from "../server/auth.js";
import { bad, bold, dim, field, heading, ok, warn } from "./style.js";
import { acceptingAsker, terminalAsker } from "./prompt.js";
import type { Asker } from "./prompt.js";
import { detectProject } from "./detect.js";

/**
 * What the machine's config.yml holds for a project: how to reach it.
 *
 * Build behaviour deliberately absent — it lives in the repository's
 * `laneyard.yml`, where it can be committed and shared. Anything from there may
 * still be written here by hand for a repository one would rather not touch.
 */
export interface NewProjectEntry {
  slug: string;
  name: string;
  git_url: string;
  default_branch: string;
  fastlane_dir?: string;
  runtime?: "bundle" | "system";
  artifact_globs?: string[];
}

/**
 * Adds a project block to config.yml while preserving the rest of the file.
 *
 * The edit goes through the YAML document rather than a parse/serialize
 * round trip: the user's comments — and the order of their keys — survive.
 * It's the same requirement as for the Fastfile: a hand-written file must
 * never come back out damaged.
 */
export async function addProjectToConfig(path: string, entry: NewProjectEntry): Promise<void> {
  let doc: Document.Parsed | Document;
  try {
    doc = parseDocument(await readFile(path, "utf8"));
  } catch {
    doc = new Document({});
  }
  if (doc.contents === null) doc = new Document({});

  if (!doc.hasIn(["server", "password_hash"])) {
    // A server with no password would refuse every connection: we generate one
    // and print it once, leaving it to the caller to note it down.
    const generated = randomBytes(9).toString("base64url");
    doc.setIn(["server", "password_hash"], hashPassword(generated));
    process.stdout.write(`\nGenerated password: ${generated}\n  (write it down, it won't be shown again)\n`);
  }

  const projects = doc.getIn(["projects"]);
  const seq = projects instanceof YAMLSeq ? projects : new YAMLSeq();
  if (!(projects instanceof YAMLSeq)) doc.setIn(["projects"], seq);

  for (const item of seq.items) {
    const slug = (item as { get?: (k: string) => unknown }).get?.("slug");
    if (slug === entry.slug) {
      throw new Error(`A project already uses the slug "${entry.slug}" in ${path}`);
    }
  }

  seq.add(doc.createNode(entry));
  await writeFile(path, doc.toString(), "utf8");
}

/** Entry point for `laneyard setup`. */
export interface SetupOptions {
  slug?: string;
  /** Accept every proposal without asking. For scripts. */
  yes?: boolean;
  asker?: Asker;
}

/**
 * Entry point for `laneyard setup`.
 *
 * It proposes rather than decides. An earlier version detected everything
 * silently and wrote a configuration that looked plausible and pointed nowhere —
 * the failure only surfaced later, as an unreadable lane list, far from its
 * cause. Showing the values and letting them be corrected costs one screen and
 * removes a whole class of that.
 */
export async function runSetupCommand(
  cwd: string,
  configPath: string,
  options: SetupOptions = {},
): Promise<number> {
  const d = await detectProject(cwd);

  if (d.fastlaneDir === null) {
    process.stderr.write(
      "No Fastfile found here. Laneyard drives fastlane: run the command from a project " +
        "that already uses it, or run `fastlane init` first.\n",
    );
    return 1;
  }
  if (d.gitUrl === null) {
    process.stderr.write(
      "No git remote named \"origin\". Laneyard clones projects from their repository: " +
        "add a remote, or set git_url by hand in config.yml.\n",
    );
    return 1;
  }

  const interactive = options.asker === undefined && options.yes !== true;
  const asker = options.asker ?? (options.yes ? acceptingAsker : terminalAsker());

  try {
    process.stdout.write(heading("Found a fastlane project"));
    process.stdout.write(field("repository", repositoryLabel(d.gitUrl)) + "\n");
    if (d.subPath !== "") {
      process.stdout.write(field("in", `${d.subPath}/`) + "\n");
    }

    // Two files, two purposes, and the difference is the one thing people get
    // wrong here — so it is stated before anything is written rather than
    // discovered afterwards when nothing turns out to be versioned.
    process.stdout.write(
      "\n" +
        dim("  Two files will describe it:\n") +
        dim(`    ${LANEYARD_YML.padEnd(13)}in the repository — how it builds. Commit it.\n`) +
        dim(`    ${"config.yml".padEnd(13)}on this machine — where to clone it from, and your\n`) +
        dim(`                 password. Never committed.\n`),
    );

    const existing = await existingProject(configPath, d.slug);
    if (existing) {
      process.stdout.write(
        "\n" +
          warn(`This machine already knows a project called ${bold(existing)}.\n`) +
          dim("  Continuing replaces its entry. Give it another name to keep both.\n"),
      );
    }

    const repoConfigPath = join(repoRoot(cwd, d.subPath), LANEYARD_YML);
    if (await fileExists(repoConfigPath)) {
      process.stdout.write(
        "\n" + warn(`${LANEYARD_YML} already exists in the repository.\n`) +
          dim("  Its values win over anything written here; it will be left alone.\n"),
      );
    }

    if (interactive) {
      process.stdout.write("\n" + dim("Press Return to accept a value, or type a new one.") + "\n\n");
    }

    const slug = options.slug ?? (await asker.ask("name for this project", d.slug));
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      process.stderr.write("\n" + bad(`Invalid name: "${slug}". Lowercase letters, digits and hyphens only.`) + "\n");
      return 1;
    }

    const gitUrl = await asker.ask("repository", d.gitUrl);
    const branch = await asker.ask(
      "default branch",
      d.defaultBranch,
      dim("A run uses this branch unless you pick another one when you start it."),
    );
    const fastlaneDir = await asker.ask(
      "fastlane directory",
      d.fastlaneDir,
      dim("Relative to the repository root, because that is what Laneyard clones."),
    );

    const useBundler = await asker.confirm(
      "\n" +
        dim("  With bundler, runs use the fastlane version pinned in the Gemfile.\n") +
        dim("  Without it, whichever fastlane is installed on the build machine.\n") +
        "  Run fastlane through bundler?",
      d.runtime === "bundle",
    );
    const runtime = useBundler ? "bundle" : "system";

    // Artifact patterns are shown, not asked: typing four globs correctly at a
    // prompt is a miserable way to start, the detected ones are nearly always
    // right, and the file is there to be edited when they are not.
    const globs = d.artifactGlobs;

    if (!(await asker.confirm(`\n${bold(`Set up "${slug}"`)}?`, true))) {
      process.stdout.write(dim("Nothing written.") + "\n");
      return 0;
    }

    // The machine half: how to reach the project. Nothing here belongs in a
    // repository — it is this server's own registry, plus its credentials.
    await addProjectToConfig(configPath, {
      slug,
      name: slug,
      git_url: gitUrl,
      default_branch: branch,
    });

    // The repository half: how it builds. This is the part that was going into
    // the machine's file and therefore never being committed — which is exactly
    // backwards, since it is the part a colleague needs.
    const wroteRepoConfig = await writeRepoConfigIfAbsent(repoConfigPath, {
      fastlane_dir: fastlaneDir,
      runtime,
      artifact_globs: globs,
      // Written down rather than re-inferred on every readiness check: a value
      // in a file can be corrected when the guess was wrong, and setup and the
      // checklist cannot end up disagreeing about the same repository.
      ...(d.platforms.length > 0 ? { platforms: d.platforms } : {}),
    });

    const port = await configuredPort(configPath);

    process.stdout.write(
      heading(`Project "${slug}" is set up`) +
        field("repository", `${gitUrl} (${branch})`) + "\n" +
        field("fastlane", fastlaneDir) + "\n" +
        field("runtime", runtime) + "\n" +
        field("artifacts", globs.join(", ") || dim("none detected")) + "\n" +
        // Shown because it decides which half of the readiness checklist a
        // project is held to, and because a wrong guess is corrected by editing
        // one line of the file just written.
        field("platforms", d.platforms.join(", ") || dim("none detected")) + "\n" +
        "\n" +
        (wroteRepoConfig
          ? ok(`Wrote ${bold(LANEYARD_YML)} — ${bold("commit it")} so your team builds the same way.\n`)
          : warn(`Left the existing ${LANEYARD_YML} alone.\n`)) +
        ok(`Registered in ${configPath}\n`) +
        heading("Start Laneyard") +
        `  ${bold("laneyard")}\n` +
        `  ${dim(`http://localhost:${port}`)}\n` +
        "\n" +
        dim("Already running? The configuration is watched — it appears on its own.\n"),
    );
    return 0;
  } finally {
    asker.close();
  }
}

/**
 * The port the server will actually listen on.
 *
 * Read back from the file rather than assumed: telling someone to open a port
 * their configuration does not use is the kind of small wrongness that makes a
 * tool feel unreliable on first contact.
 */
async function configuredPort(configPath: string): Promise<number> {
  const res = await loadServerConfig(configPath);
  return res.ok ? res.config.server.port : 7890;
}

/** The repository file, named once so the message and the write cannot disagree. */
const LANEYARD_YML = "laneyard.yml";

/**
 * The repository root, from where the command ran and how deep it sits.
 *
 * `laneyard.yml` belongs at the root because that is where the server reads it:
 * the clone is the repository, not the sub-directory someone was standing in.
 */
function repoRoot(cwd: string, subPath: string): string {
  return subPath === "" ? cwd : join(cwd, ...subPath.split("/").map(() => ".."));
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
};

/** The name already registered under this slug, or null. */
async function existingProject(configPath: string, slug: string): Promise<string | null> {
  const res = await loadServerConfig(configPath);
  if (!res.ok) return null;
  return res.config.projects.find((p) => p.slug === slug)?.slug ?? null;
}

/**
 * Writes the repository's build configuration, unless it is already there.
 *
 * Never overwrites: a `laneyard.yml` in a repository was put there by someone,
 * possibly with comments and choices this command knows nothing about, and its
 * values win anyway.
 */
async function writeRepoConfigIfAbsent(
  path: string,
  settings: {
    fastlane_dir: string;
    runtime: string;
    artifact_globs: string[];
    platforms?: string[];
  },
): Promise<boolean> {
  if (await fileExists(path)) return false;

  const doc = new Document(settings);
  doc.commentBefore =
    " How this project builds. Committed, so everyone builds it the same way.\n" +
    " Values here win over the project's block in the server's config.yml.";
  await writeFile(path, doc.toString(), "utf8");
  return true;
}

/** `git@github.com:you/thing.git` reads better as `you/thing` in a sentence. */
function repositoryLabel(url: string): string {
  return url.replace(/^.*[:/]([^/:]+\/[^/]+?)(\.git)?$/, "$1");
}

import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Document, parseDocument, YAMLSeq } from "yaml";
import { hashPassword } from "../server/auth.js";
import { acceptingAsker, terminalAsker } from "./prompt.js";
import type { Asker } from "./prompt.js";
import { detectProject } from "./detect.js";

export interface NewProjectEntry {
  slug: string;
  name: string;
  git_url: string;
  default_branch: string;
  fastlane_dir: string;
  runtime: "bundle" | "system";
  artifact_globs: string[];
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

  const asker = options.asker ?? (options.yes ? acceptingAsker : terminalAsker());

  try {
    process.stdout.write(`\nFound a fastlane project.\n`);
    if (d.subPath !== "") {
      // The single most confusing thing this command can get wrong, so it is
      // stated rather than implied: paths are relative to the repository,
      // because the repository is what Laneyard clones.
      process.stdout.write(
        `  It sits in \`${d.subPath}/\` inside ${repositoryLabel(d.gitUrl)}, and Laneyard clones\n` +
          `  the whole repository — so the paths below are relative to its root.\n`,
      );
    }
    process.stdout.write("\nPress Return to accept a value, or type a new one.\n\n");

    const slug = options.slug ?? (await asker.ask("name for this project", d.slug));
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      process.stderr.write(`\nInvalid name: "${slug}". Lowercase letters, digits and hyphens only.\n`);
      return 1;
    }

    const gitUrl = await asker.ask("repository", d.gitUrl);
    const branch = await asker.ask("branch to build", d.defaultBranch);
    const fastlaneDir = await asker.ask("fastlane directory", d.fastlaneDir);
    const runtime = (await asker.ask("how to run fastlane (bundle|system)", d.runtime)) as
      | "bundle"
      | "system";
    const globs = (await asker.ask("artifacts to keep", d.artifactGlobs.join(", ")))
      .split(",")
      .map((g) => g.trim())
      .filter((g) => g !== "");

    if (!(await asker.confirm(`\nAdd "${slug}" to ${configPath}?`, true))) {
      process.stdout.write("Nothing written.\n");
      return 0;
    }

    await addProjectToConfig(configPath, {
      slug,
      name: slug,
      git_url: gitUrl,
      default_branch: branch,
      fastlane_dir: fastlaneDir,
      runtime,
      artifact_globs: globs,
    });

    process.stdout.write(
      `\nProject "${slug}" added to ${configPath}\n` +
        `  repository   ${gitUrl} (${branch})\n` +
        `  fastlane     ${fastlaneDir}\n` +
        `  runtime      ${runtime}\n` +
        `  artifacts    ${globs.join(", ") || "none — set artifact_globs by hand"}\n` +
        `\nRestart Laneyard or wait for the automatic reload, the project will appear in the interface.\n`,
    );
    return 0;
  } finally {
    asker.close();
  }
}

/** `git@github.com:you/thing.git` reads better as `you/thing` in a sentence. */
function repositoryLabel(url: string): string {
  return url.replace(/^.*[:/]([^/:]+\/[^/]+?)(\.git)?$/, "$1");
}

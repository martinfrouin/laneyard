import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Document, parseDocument, YAMLSeq } from "yaml";
import { hashPassword } from "../server/auth.js";
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

/** Entry point for `laneyard add`. */
export async function runAddCommand(cwd: string, configPath: string, slugOverride?: string): Promise<number> {
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

  const slug = slugOverride ?? d.slug;

  // A slug is used as a folder name and a URL segment. Left unvalidated, a
  // `--slug ../evil` would be written without complaint and would then make
  // config.yml invalid, taking every other project offline.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    process.stderr.write(
      `Invalid slug: "${slug}". Lowercase letters, digits and hyphens only.\n`,
    );
    return 1;
  }
  await addProjectToConfig(configPath, {
    slug,
    name: slug,
    git_url: d.gitUrl,
    default_branch: d.defaultBranch,
    fastlane_dir: d.fastlaneDir,
    runtime: d.runtime,
    artifact_globs: d.artifactGlobs,
  });

  process.stdout.write(
    `\nProject "${slug}" added to ${configPath}\n` +
      `  repository   ${d.gitUrl} (${d.defaultBranch})\n` +
      `  fastlane     ${d.fastlaneDir}\n` +
      `  runtime      ${d.runtime}\n` +
      `  artifacts    ${d.artifactGlobs.join(", ") || "no pattern detected — fill in manually"}\n` +
      `\nRestart Laneyard or wait for the automatic reload, the project will appear in the interface.\n`,
  );
  return 0;
}

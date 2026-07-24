import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { Document, parseDocument, YAMLSeq } from "yaml";
import { VALID_NAME, ensureFirstAdmin, hasAccount } from "../config/accounts.js";
import { loadServerConfig } from "../config/load.js";
import { serializeYaml as serialize } from "../config/yaml.js";
import { bad, bold, dim, field, heading, ok, warn } from "./style.js";
import { acceptingAsker, terminalAsker } from "./prompt.js";
import type { Asker } from "./prompt.js";
import { detectProject } from "./detect.js";
import { appRootOf } from "../heuristics/platforms.js";
import { CredentialStore } from "../db/credentials.js";
import { openDatabase } from "../db/open.js";
import { SecretStore } from "../db/secrets.js";
import { Vault } from "../secrets/vault.js";
import { runAdoption } from "./adopt.js";

const exec = promisify(execFile);

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
 * It writes no account: accounts are `ensureFirstAdmin`'s business, and a
 * function that registered a project *and* invented a password would have two
 * reasons to be called and one of them a surprise.
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

  const projects = doc.getIn(["projects"]);
  const seq = projects instanceof YAMLSeq ? projects : new YAMLSeq();
  if (!(projects instanceof YAMLSeq)) doc.setIn(["projects"], seq);

  // An entry of the same name is updated, not refused.
  //
  // Setup prints "Continuing replaces its entry" before asking anything, and
  // then this threw — so the one way to correct a stale entry, running setup
  // again, was the one thing that could not be done. A project written by an
  // older version and missing a field it now needs was unfixable except by hand.
  //
  // Field by field rather than wholesale, though the warning says "replaces":
  // an entry may carry things setup knows nothing about — a `git_auth` pointing
  // at an SSH key, a raised `timeout_minutes` — and losing those silently, on a
  // command someone ran to fix something else, would be its own bug.
  const existing = seq.items.find(
    (item) => (item as { get?: (k: string) => unknown }).get?.("slug") === entry.slug,
  ) as { set?: (k: string, v: unknown) => void } | undefined;

  if (existing?.set) {
    for (const [key, value] of Object.entries(entry)) existing.set(key, value);
  } else {
    seq.add(doc.createNode(entry));
  }

  await writeFile(path, serialize(doc), "utf8");
}

/**
 * Takes a project's block out of config.yml, leaving the rest of the file alone.
 *
 * Same requirement as `addProjectToConfig`, and for the same reason: the file is
 * hand-written, so the edit goes through the YAML document and every comment,
 * key order and blank line that isn't this project's survives it.
 *
 * Returns false when no block carried that slug, so the caller can answer 404
 * rather than rewrite the file to say the same thing it already said.
 */
export async function removeProjectFromConfig(path: string, slug: string): Promise<boolean> {
  const doc = parseDocument(await readFile(path, "utf8"));
  const projects = doc.getIn(["projects"]);
  if (!(projects instanceof YAMLSeq)) return false;

  const at = projects.items.findIndex(
    (item) => (item as { get?: (k: string) => unknown }).get?.("slug") === slug,
  );
  if (at === -1) return false;

  projects.items.splice(at, 1);
  await writeFile(path, serialize(doc), "utf8");
  return true;
}

/**
 * Empties the project list, leaving the `server:` block and the file's shape.
 *
 * What `laneyard reset` does to config.yml: every project goes, the accounts and
 * the port stay. The same YAML-document edit as removing one project, and for
 * the same reason — the file is hand-written, so its comments and its key order
 * must survive being touched. The items are spliced out of the existing sequence
 * rather than the key replaced, so `projects:` keeps its place and any comment
 * sitting on it.
 *
 * Returns how many blocks were removed, so the caller can report the count.
 */
export async function clearProjectsInConfig(path: string): Promise<number> {
  const doc = parseDocument(await readFile(path, "utf8"));
  const projects = doc.getIn(["projects"]);
  if (!(projects instanceof YAMLSeq) || projects.items.length === 0) return 0;

  const removed = projects.items.length;
  projects.items.splice(0, removed);
  await writeFile(path, serialize(doc), "utf8");
  return removed;
}

/** Entry point for `laneyard setup`. */
export interface SetupOptions {
  slug?: string;
  /** Accept every proposal without asking. For scripts. */
  yes?: boolean;
  asker?: Asker;
  /**
   * Laneyard's home, for the vault the second act writes to.
   *
   * Optional so that every existing test — and any caller that only wants a
   * project registered — keeps working: without it, adoption is skipped
   * entirely rather than half-run.
   */
  home?: string;
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
          dim("  Continuing updates its entry, keeping anything you added by hand.\n") +
          dim("  Give it another name to keep both.\n"),
      );
    }

    // A machine with no account gets its first admin here. Asked rather than
    // assumed: the name is typed into a login form every day afterwards, and
    // `admin` is a poor thing to call a person once there are two of them.
    const firstAccount = !(await hasAccount(configPath));
    if (firstAccount) {
      process.stdout.write(
        "\n" +
          warn("This machine has no account yet.\n") +
          dim("  You will sign in with a name and a password. The password is generated below.\n"),
      );
    }

    if (interactive) {
      process.stdout.write("\n" + dim("Press Return to accept a value, or type a new one.") + "\n\n");
    }

    const adminName = firstAccount
      ? await asker.ask("your name for signing in", DEFAULT_ADMIN_NAME)
      : null;
    if (adminName !== null && !VALID_NAME.test(adminName)) {
      process.stderr.write(
        "\n" + bad(`Invalid name: "${adminName}". Letters, digits, dot, dash and underscore.`) + "\n",
      );
      return 1;
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
    // Asked as it is written from where the command ran: from `app/`, the folder
    // is `fastlane`, not `app/fastlane`. The repository-root-relative form is
    // what the clone has and what `config.yml` stores, but prefixing it is
    // Laneyard's job — asking someone to type a path they are standing inside
    // reads like a mistake, and is the one people correct wrongly.
    const fastlaneDir = fromRepoRoot(
      d.subPath,
      await asker.ask(
        "fastlane directory",
        fromHere(d.subPath, d.fastlaneDir),
        dim("Relative to this directory."),
      ),
    );

    // Computed from the answer, never from the detection: correcting the folder
    // moves the app root with it, and with it where `laneyard.yml` is written and
    // which prefix its paths drop. Read before the prompt, a correction was
    // silently ignored and the file landed beside the wrong app.
    const appRoot = appRootOf(fastlaneDir);
    const repoConfigPath = join(repoRoot(cwd, d.subPath), appRoot, LANEYARD_YML);
    const repoConfigExists = await fileExists(repoConfigPath);
    if (repoConfigExists) {
      process.stdout.write(
        "\n" + warn(`${LANEYARD_YML} already exists in the repository.\n`) +
          dim("  Its values win over anything written here; it will be left alone.\n"),
      );
    }

    // A fastlane folder that is on disk but not in git will not survive the
    // clone Laneyard builds from — the case that started this: a stray
    // `app copie/` macOS made, detected here and absent from the remote.
    // Warned, not refused: setup proposes and the user decides, exactly as with
    // every value above. Silent when git cannot answer — a courtesy, not a gate.
    if (!(await fastlaneDirIsTracked(repoRoot(cwd, d.subPath), fastlaneDir))) {
      process.stdout.write(
        "\n" +
          warn(`${bold(fastlaneDir)} exists here but is not tracked by git.\n`) +
          dim("  Laneyard builds from a clone of the remote, so a path that is not in\n") +
          dim("  git will not be in the clone — the build will fail looking for it.\n") +
          dim("  Commit and push it, or give a path that is in git.\n"),
      );
    }

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

    // What pressing Return does, named right above the question. It used to be a
    // bare `Set up "x"?` at the end of a run of unrelated questions, with the two
    // files it writes explained far enough up the screen to have scrolled off.
    const writes =
      "\n" +
      dim(`  ${configPath}\n`) +
      dim(`    this machine's registry${adminName === null ? "" : ", and your account"}\n`) +
      dim(`  ${relative(cwd, repoConfigPath) || LANEYARD_YML}\n`) +
      dim(`    how it builds — ${repoConfigExists ? "already there, left as it is" : "commit it"}\n`);

    if (!(await asker.confirm(`${writes}\n${bold(`Set up "${slug}"`)}?`, true))) {
      process.stdout.write(dim("Nothing written.") + "\n");
      return 0;
    }

    // The account first, so the server block is written before the project list
    // it sits above. `null` when this machine already has one, and then nothing
    // is written and nothing is printed.
    const generatedPassword =
      adminName === null ? null : await ensureFirstAdmin(configPath, adminName);

    // The machine half: how to reach the project. Nothing here belongs in a
    // repository — it is this server's own registry, plus its credentials.
    await addProjectToConfig(configPath, {
      slug,
      name: slug,
      git_url: gitUrl,
      default_branch: branch,
      // Written on this machine too, and only when it is not the default,
      // because of the gap between the two files. Laneyard builds from a clone
      // of the remote, so nothing written into the working copy reaches it
      // until `laneyard.yml` is committed and pushed — and until then
      // `fastlane_dir` falls back to `fastlane`, which in a monorepo is not
      // where anything is. The project was unreadable from the moment setup
      // finished until a git push, with an ENOENT for an explanation.
      //
      // This is not a second source of truth: the repository file wins the
      // moment it lands, which is the precedence `config.yml` already
      // documents and the schema already allows. It is the value setup just
      // proposed and the user just accepted, kept where it is useful until the
      // authoritative copy arrives.
      //
      // Omitted when it *is* the default, so an ordinary project's block stays
      // about how the project is reached and nothing else.
      // Both of the fields the sidecar needs before it can read anything, and
      // only when they are not already the default. `runtime` belongs here for
      // exactly the same reason as `fastlane_dir`: without it the sidecar is
      // launched under `bundle exec` and a project that uses a system fastlane
      // fails with "Could not locate Gemfile" — the same bootstrap gap, one
      // field along.
      ...(fastlaneDir === "fastlane" ? {} : { fastlane_dir: fastlaneDir }),
      ...(runtime === "bundle" ? {} : { runtime }),
    });

    // The repository half: how it builds. This is the part that was going into
    // the machine's file and therefore never being committed — which is exactly
    // backwards, since it is the part a colleague needs.
    //
    // Its paths are written relative to the app's own directory, because the file
    // lives there: `fastlane_dir` is omitted when it is the plain `fastlane` the
    // default already assumes, and each glob is stripped of the app prefix. An
    // app moved or duplicated keeps this file unchanged; `store.ts` puts the
    // prefix back when it reads it.
    const wroteRepoConfig = await writeRepoConfigIfAbsent(repoConfigPath, {
      // First, as the file's identity: `remove` reads it from here.
      slug,
      ...(appRelative(appRoot, fastlaneDir) === "fastlane"
        ? {}
        : { fastlane_dir: appRelative(appRoot, fastlaneDir) }),
      runtime,
      artifact_globs: globs.map((g) => appRelative(appRoot, g)),
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
        // Last thing before the invitation to start the server, because it is
        // the one line here that cannot be read again anywhere: the file holds
        // a hash, and nothing holds the password.
        (generatedPassword === null
          ? ""
          : heading("Your account") +
            field("name", bold(adminName!)) + "\n" +
            field("password", bold(generatedPassword)) + "\n" +
            field("role", "admin") + "\n" +
            "\n" +
            warn("Write the password down — it is not shown again, and it is not stored.\n") +
            dim("  Add a colleague later with `laneyard user add <name> --role builder`.\n")) +
        heading("Start Laneyard") +
        `  ${bold("laneyard")}\n` +
        `  ${dim(`http://localhost:${port}`)}\n` +
        "\n" +
        dim("Already running? The configuration is watched — it appears on its own.\n"),
    );

    // The second act. After the success message, never before it: declining
    // everything here must leave exactly the project the lines above just
    // announced. See `cli/adopt.ts`.
    //
    // The repository root, not `cwd`: `fastlaneDir` is measured from there, and
    // so are the credential paths a Fastfile one directory down writes and the
    // `git ls-files` that asks whether they are committed.
    if (options.home !== undefined) {
      const db = openDatabase(join(options.home, "laneyard.db"));
      try {
        const vault = await Vault.open(options.home, new SecretStore(db), new CredentialStore(db));
        await runAdoption({ cwd: repoRoot(cwd, d.subPath), fastlaneDir, slug, vault, asker });
      } catch (cause) {
        // Adoption is a courtesy on top of a command that has already
        // succeeded. Its failure is reported and swallowed: exiting non-zero
        // here would say the project was not set up, and the project is set up.
        process.stdout.write(
          "\n" + warn(`Could not finish reading your Fastfile: ${(cause as Error).message}\n`),
        );
      } finally {
        db.close();
      }
    }
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

/** What the first account is called when nobody says otherwise. */
const DEFAULT_ADMIN_NAME = "admin";

/**
 * The repository root, from where the command ran and how deep it sits.
 *
 * The anchor everything else is measured against: the clone is the whole
 * repository, not the sub-directory someone was standing in, so `config.yml`'s
 * `fastlane_dir` and the app directory `laneyard.yml` lands in are both relative
 * to here, whichever folder setup was run from.
 */
function repoRoot(cwd: string, subPath: string): string {
  return subPath === "" ? cwd : join(cwd, ...subPath.split("/").map(() => ".."));
}

/**
 * Whether git tracks anything under a path in the working copy setup ran in.
 *
 * A folder can be on disk and absent from git — untracked, gitignored, or a
 * stray local copy — and such a folder does not survive the clone Laneyard
 * builds from. `git ls-files` lists nothing under an untracked path, so an
 * empty listing is the signal. Returns true — warning nothing — when git
 * cannot answer at all (not a repository, git missing): the check is a
 * courtesy, and setup must not crash on its account.
 */
export async function fastlaneDirIsTracked(root: string, dir: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["ls-files", "--", dir], { cwd: root });
    return stdout.trim() !== "";
  } catch {
    return true;
  }
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
    slug: string;
    fastlane_dir?: string;
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

/**
 * A repo-root-relative path read as relative to the app directory.
 *
 * The inverse of what `store.ts` does when it reads an app-level file: the file
 * lives in `<appRoot>/`, so its paths drop that prefix. `.` is the repository
 * root — a path there is already app-relative and unchanged. A path that does
 * not sit under the app (an unanchored glob like `**​/*.ipa`) is left as it is;
 * it still means the same thing once the read-time prefix is applied.
 */
function appRelative(appRoot: string, p: string): string {
  if (appRoot === "" || appRoot === ".") return p;
  const prefix = `${appRoot}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * A repository-root-relative path as it is written from where setup ran.
 *
 * `app/fastlane` is `fastlane` when standing in `app/`. A path outside that
 * directory has no shorter form and is shown as it is.
 */
function fromHere(subPath: string, repoRelative: string): string {
  if (subPath === "") return repoRelative;
  const prefix = `${subPath}/`;
  return repoRelative.startsWith(prefix) ? repoRelative.slice(prefix.length) : repoRelative;
}

/**
 * The inverse: back to repository-root-relative, which is the shape of the clone.
 *
 * Tolerant of an answer that already carries the prefix — someone who types
 * `app/fastlane` from `app/` means the same folder, and double-prefixing it into
 * `app/app/fastlane` would be a worse answer than the one they gave.
 */
function fromRepoRoot(subPath: string, here: string): string {
  if (subPath === "" || here === "") return here;
  return here === subPath || here.startsWith(`${subPath}/`) ? here : `${subPath}/${here}`;
}

/** `git@github.com:you/thing.git` reads better as `you/thing` in a sentence. */
function repositoryLabel(url: string): string {
  return url.replace(/^.*[:/]([^/:]+\/[^/]+?)(\.git)?$/, "$1");
}

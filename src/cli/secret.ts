import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { applyImport, envFilesIn, parseEnvFile, planImport } from "./secret-import.js";
import { ConfigStore } from "../config/store.js";
import { openDatabase } from "../db/open.js";
import { CredentialStore } from "../db/credentials.js";
import { SecretStore } from "../db/secrets.js";
import { MIN_LENGTH as MIN_REDACTABLE } from "../logs/redact.js";
import { Vault } from "../secrets/vault.js";

/** Same rule as the API: what cannot become an environment variable is refused here too. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SECRET_USAGE = `laneyard secret set <NAME> [--project <slug>] [--no-mask]
laneyard secret import --project <slug> [--yes]

The value is read from standard input, never from an argument:

  laneyard secret set MATCH_PASSWORD --project app
  echo "$TOKEN" | laneyard secret set GITHUB_TOKEN

\`import\` reads this project's fastlane/.env and stores what it finds. A
variable naming a .p8 or a service account JSON has the *file* stored, under the
name fastlane looks for — a path does not travel to a build machine.
`;

export interface SecretCommandIo {
  stdin: Readable;
  /** True when stdin is a terminal, meaning nothing is being piped in. */
  interactive: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * Reads standard input whole.
 *
 * A single trailing newline is dropped: `echo "$TOKEN" |` adds one, and a secret
 * that silently gained a `\n` would fail authentication somewhere far away from
 * here, with nothing on screen to explain why.
 */
async function readValue(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks).toString("utf8");
  return text.replace(/\r?\n$/, "");
}

interface Parsed {
  key: string;
  project: string | null;
  masked: boolean;
}

function parse(args: string[]): Parsed | string {
  let key: string | null = null;
  let project: string | null = null;
  let masked = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--project" || arg === "-p") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) return "--project needs a project slug.";
      project = next;
      i += 1;
    } else if (arg === "--no-mask") {
      masked = false;
    } else if (arg.startsWith("-")) {
      return `Unknown option: ${arg}`;
    } else if (key === null) {
      key = arg;
    } else {
      // A second bare argument is almost certainly the value typed on the command
      // line — exactly what this command exists to prevent. Saying so is kinder
      // than storing the name and ignoring the rest.
      return "The value is read from standard input, not from the command line.";
    }
  }

  if (key === null) return "Which secret? Give it a name.";
  return { key, project, masked };
}

/**
 * Entry point for `laneyard secret set`.
 *
 * Nothing it prints ever contains the value — not on success, not in an error.
 * A terminal keeps scrollback and a shell keeps history; the point of reading
 * from stdin would be lost if the value came straight back out.
 */
export async function runSecretCommand(home: string, args: string[], io: SecretCommandIo): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === "import") {
    return runSecretImport(home, rest, io);
  }

  if (subcommand !== "set") {
    io.err(subcommand === undefined ? `${SECRET_USAGE}` : `Unknown subcommand: ${subcommand}\n\n${SECRET_USAGE}`);
    return 1;
  }

  const parsed = parse(rest);
  if (typeof parsed === "string") {
    io.err(`${parsed}\n\n${SECRET_USAGE}`);
    return 1;
  }

  if (!VALID_KEY.test(parsed.key)) {
    io.err(
      `"${parsed.key}" is not a valid environment variable name: letters, digits and underscore, ` +
        "not starting with a digit.\n",
    );
    return 1;
  }

  // A slug typo would store a secret that no project ever sees, and the run
  // would fail much later with fastlane complaining about a missing variable.
  if (parsed.project !== null) {
    const config = new ConfigStore(join(home, "config.yml"));
    const loaded = await config.load();
    if (!loaded.ok) {
      io.err(`Unreadable configuration in ${join(home, "config.yml")}: ${loaded.error}\n`);
      return 1;
    }
    if (!config.project(parsed.project)) {
      const known = config.projects().map((p) => p.slug);
      io.err(
        `Unknown project: "${parsed.project}".` +
          (known.length > 0 ? ` Known projects: ${known.join(", ")}.` : " No project is declared yet.") +
          "\n",
      );
      return 1;
    }
  }

  if (io.interactive) {
    io.err(
      "The value is read from standard input, and standard input is a terminal.\n" +
        "Pipe it in instead, so it stays out of your shell history:\n\n" +
        `  echo "$TOKEN" | laneyard secret set ${parsed.key}\n`,
    );
    return 1;
  }

  const value = await readValue(io.stdin);
  if (value === "") {
    io.err("Nothing came in on standard input, so there is no value to store.\n");
    return 1;
  }
  // Same refusal as the API: accepting the request and quietly not redacting
  // would leave someone believing they are protected.
  if (parsed.masked && value.length < MIN_REDACTABLE) {
    io.err(
      `A value kept out of the logs must be at least ${MIN_REDACTABLE} characters. ` +
        "Shorter than that, removing it would shred the log without hiding anything. " +
        "Pass --no-mask if you accept it appearing in the output.\n",
    );
    return 1;
  }

  const db = openDatabase(join(home, "laneyard.db"));
  try {
    const vault = await Vault.open(home, new SecretStore(db), new CredentialStore(db));
    await vault.set(parsed.project, parsed.key, value, parsed.masked);
  } finally {
    db.close();
  }

  io.out(
    `✓ ${parsed.key}  ${parsed.project === null ? "global" : `project ${parsed.project}`}` +
      `  ${parsed.masked ? "kept out of the logs" : "shown in the logs"}\n`,
  );
  return 0;
}

/**
 * `laneyard secret import` — the existing `.env` into the vault.
 *
 * Shows what it would do before doing it, in names only. An import that reads
 * eight files and writes eight secrets before saying a word is one nobody can
 * check, and this is the one command that handles every credential a project
 * has at once.
 */
async function runSecretImport(home: string, args: string[], io: SecretCommandIo): Promise<number> {
  let project: string | null = null;
  let yes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--project" || arg === "-p") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        io.err("--project needs a slug.\n");
        return 1;
      }
      project = next;
      i += 1;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else {
      io.err(`Unknown option: ${arg}\n\n${SECRET_USAGE}`);
      return 1;
    }
  }

  if (project === null) {
    io.err("Which project? Give it with --project <slug>.\n");
    return 1;
  }

  const config = new ConfigStore(join(home, "config.yml"));
  const loaded = await config.load();
  if (!loaded.ok) {
    io.err(`Unreadable configuration in ${join(home, "config.yml")}: ${loaded.error}\n`);
    return 1;
  }
  const entry = config.project(project);
  if (!entry) {
    const known = config.projects().map((p) => p.slug);
    io.err(
      `Unknown project: "${project}".` +
        (known.length > 0 ? ` Known projects: ${known.join(", ")}.` : " No project is declared yet.") +
        "\n",
    );
    return 1;
  }

  // Read from the working copy this command was run in — the only place a
  // gitignored `.env` exists; the server's clone never has one.
  //
  // Resolved against the repository root, not the current directory:
  // `fastlane_dir` is recorded relative to the root, so running this from
  // `app/` would otherwise look for `app/app/fastlane/.env`. The same
  // confusion, one command along, as the one that produced an ENOENT in the
  // lane list.
  const fastlaneDir = entry.fastlane_dir ?? "fastlane";
  const root = await repositoryRoot(process.cwd());
  const env = new Map<string, string>();
  const readFrom: string[] = [];
  for (const file of envFilesIn(fastlaneDir)) {
    const text = await readFile(join(root, file), "utf8").catch(() => null);
    if (text === null) continue;
    readFrom.push(file);
    for (const [k, v] of parseEnvFile(text)) env.set(k, v);
  }

  if (readFrom.length === 0) {
    io.err(
      `No ${fastlaneDir}/.env under ${root}. Run this from the working copy that has one — ` +
        "it is the file that never reaches a clone, which is the whole reason for this command.\n",
    );
    return 1;
  }

  const db = openDatabase(join(home, "laneyard.db"));
  try {
    const vault = await Vault.open(home, new SecretStore(db), new CredentialStore(db));
    // Paths inside a `.env` are written relative to where fastlane runs, which
    // is the fastlane directory's parent — the app, not the repository root.
    const plan = await planImport(
      env,
      join(root, fastlaneDir, ".."),
      vault.list(project).map((s) => s.key),
    );

    if (plan.planned.length === 0) {
      io.out(`Nothing to import from ${readFrom.join(" and ")}.\n`);
      return 0;
    }

    io.out(`\nFrom ${readFrom.join(" and ")}, into "${project}":\n\n`);
    for (const item of plan.planned) {
      if (item.kind === "unresolved-path") {
        io.out(`  ✗ ${item.key} — names ${item.path}, which is not there. Skipped.\n`);
      } else if (item.kind === "file-contents") {
        io.out(`  ● ${item.key}${item.from ? ` (the contents of ${item.from})` : ""}\n`);
      } else {
        io.out(`  ● ${item.key}\n`);
      }
    }
    if (plan.replacing.length > 0) {
      io.out(`\n  ${plan.replacing.join(", ")} already in the vault — they will be replaced.\n`);
    }

    const skipped = plan.planned.filter((p) => p.kind === "unresolved-path");
    if (skipped.length > 0) {
      io.out("\n  A skipped file is the credential this project most needs. Check the path.\n");
    }

    if (!yes) {
      io.out("\nNothing is written yet. Run it again with --yes to store these.\n");
      return 0;
    }

    const stored = await applyImport(vault, project, plan);
    io.out(`\n✓ Stored ${stored} ${stored === 1 ? "secret" : "secrets"}, all kept out of the logs.\n`);
    // Said here because the import alone does not finish the job: the lanes
    // still ask for a path, and the vault now holds the contents.
    io.out(
      "\nYour lanes still read the path forms. Point them at the contents instead — " +
        "`key_content:` rather than `key_filepath:`, and drop `json_key:` so supply reads " +
        "SUPPLY_JSON_KEY_DATA itself.\n",
    );
    return 0;
  } finally {
    db.close();
  }
}

/**
 * The repository root, or the directory given if this is not a repository.
 *
 * `fastlane_dir` is recorded relative to the root — that is what the clone is
 * measured from — so anything resolving it has to agree about where the root is,
 * whichever sub-directory the command happens to be run from.
 */
async function repositoryRoot(from: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], {
      cwd: from,
      timeout: 5_000,
    });
    return stdout.trim() || from;
  } catch {
    return from;
  }
}

import { join } from "node:path";
import type { Readable } from "node:stream";
import { ConfigStore } from "../config/store.js";
import { openDatabase } from "../db/open.js";
import { CredentialStore } from "../db/credentials.js";
import { SecretStore } from "../db/secrets.js";
import { MIN_LENGTH as MIN_REDACTABLE } from "../logs/redact.js";
import { Vault } from "../secrets/vault.js";

/** Same rule as the API: what cannot become an environment variable is refused here too. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SECRET_USAGE = `laneyard secret set <NAME> [--project <slug>] [--no-mask]

The value is read from standard input, never from an argument:

  laneyard secret set MATCH_PASSWORD --project app
  echo "$TOKEN" | laneyard secret set GITHUB_TOKEN
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

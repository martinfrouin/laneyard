import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  MIN_PASSWORD_LENGTH,
  VALID_NAME,
  hasAccount,
  refusalFor,
  upsertUserInConfig,
} from "../config/accounts.js";
import { loadServerConfig } from "../config/load.js";
import type { UserRole } from "../config/schema.js";

export const USER_USAGE = `laneyard user add <name> [--role admin|builder]

The password is read from standard input, never from an argument:

  echo "$PASSWORD" | laneyard user add renaud --role builder

Without --role, the account is a builder: it can start a build, watch it, cancel
it and download what it produced. An admin can do everything besides.
`;

/** Same shape as \`laneyard secret set\`, for the same reason: stdin is the input. */
export interface UserCommandIo {
  stdin: Readable;
  /** True when stdin is a terminal, meaning nothing is being piped in. */
  interactive: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
}

const ROLES: UserRole[] = ["admin", "builder"];

/**
 * Reads standard input whole.
 *
 * A single trailing newline is dropped: `echo "$PASSWORD" |` adds one, and a
 * password that silently gained a `\n` is a password that never works again,
 * with nothing on screen to explain why.
 */
async function readPassword(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

interface Parsed {
  name: string;
  role: UserRole;
}

function parse(args: string[]): Parsed | string {
  let name: string | null = null;
  // The role that can do the least, when nobody says. An account that turns out
  // to need more is one command away; an account that quietly had more than it
  // needed is found out later, differently.
  let role: UserRole = "builder";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--role" || arg === "-r") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) return `--role needs ${ROLES.join(" or ")}.`;
      if (!ROLES.includes(next as UserRole)) return `Unknown role: ${next}. It is ${ROLES.join(" or ")}.`;
      role = next as UserRole;
      i += 1;
    } else if (arg.startsWith("-")) {
      return `Unknown option: ${arg}`;
    } else if (name === null) {
      name = arg;
    } else {
      // A second bare argument is almost certainly the password typed on the
      // command line — exactly what this command exists to prevent.
      return "The password is read from standard input, not from the command line.";
    }
  }

  if (name === null) return "Which account? Give it a name.";
  return { name, role };
}

/**
 * Entry point for `laneyard user`.
 *
 * Nothing it prints ever contains the password — not on success, not in an
 * error. A terminal keeps scrollback and a shell keeps history; reading from
 * stdin would be pointless if the value came straight back out.
 */
export async function runUserCommand(
  home: string,
  args: string[],
  io: UserCommandIo,
): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand !== "add") {
    io.err(
      subcommand === undefined ? USER_USAGE : `Unknown subcommand: ${subcommand}\n\n${USER_USAGE}`,
    );
    return 1;
  }

  const parsed = parse(rest);
  if (typeof parsed === "string") {
    io.err(`${parsed}\n\n${USER_USAGE}`);
    return 1;
  }

  if (!VALID_NAME.test(parsed.name)) {
    io.err(
      `"${parsed.name}" is not a name: letters, digits, dot, dash and underscore, ` +
        "starting with a letter or a digit.\n",
    );
    return 1;
  }

  const configPath = join(home, "config.yml");
  // A machine with no account at all is a machine that has not been set up. It
  // is refused here rather than given its first account, because that first
  // account has to be an admin and this command would happily write a lone
  // builder — a configuration the server then refuses to load.
  if (!(await hasAccount(configPath))) {
    io.err(
      `No account yet in ${configPath}.\n` +
        "Run `laneyard setup` from a project that uses fastlane: it creates the first admin.\n",
    );
    return 1;
  }

  const loaded = await loadServerConfig(configPath);
  if (!loaded.ok) {
    // Refused rather than written blind: the accounts already in the file are
    // what says whether this change leaves the server with an admin.
    io.err(`Unreadable configuration in ${configPath}: ${loaded.error}\n`);
    return 1;
  }

  const existing = loaded.config.server.users;
  const refusal = refusalFor(existing, parsed.name, parsed.role);
  if (refusal) {
    io.err(`${refusal}\n`);
    return 1;
  }

  if (io.interactive) {
    io.err(
      "The password is read from standard input, and standard input is a terminal.\n" +
        "Pipe it in instead, so it stays out of your shell history:\n\n" +
        `  echo "$PASSWORD" | laneyard user add ${parsed.name} --role ${parsed.role}\n`,
    );
    return 1;
  }

  const password = await readPassword(io.stdin);
  if (password === "") {
    io.err("Nothing came in on standard input, so there is no password to set.\n");
    return 1;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    io.err(`A password is at least ${MIN_PASSWORD_LENGTH} characters.\n`);
    return 1;
  }

  const { created } = await upsertUserInConfig(configPath, { ...parsed, password });

  io.out(
    `✓ ${parsed.name}  ${parsed.role}  ${created ? "added" : "replaced"}\n` +
      // The server watches config.yml, so this takes effect without a restart.
      // Saying so is what stops someone from restarting a build server for it.
      "  the running server picks this up on its own.\n",
  );
  return 0;
}

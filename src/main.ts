#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { bold, dim, field, heading } from "./cli/style.js";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { PromptAborted } from "./cli/prompt.js";
import { runSetupCommand } from "./cli/setup.js";
import { runRemoveCommand } from "./cli/remove.js";
import { runResetCommand } from "./cli/reset.js";
import { runSecretCommand } from "./cli/secret.js";
import { runUninstallCommand } from "./cli/uninstall.js";
import { runUserCommand } from "./cli/user.js";
import { ConfigStore } from "./config/store.js";
import { CacheStore } from "./db/cache.js";
import { openDatabase } from "./db/open.js";
import type { Db } from "./db/open.js";
import { RunStore } from "./db/runs.js";
import { CredentialStore } from "./db/credentials.js";
import { SecretStore } from "./db/secrets.js";
import { buildApp } from "./server/app.js";
import { Vault } from "./secrets/vault.js";
import { makeInvoke } from "./sidecar/bridge.js";
import { LaneReader } from "./sidecar/lanes.js";
import { UsesReader } from "./sidecar/uses.js";

export const version = "0.4.1";

export interface Started {
  app: FastifyInstance;
  db: Db;
  config: ConfigStore;
}

/** Assembles the server from a data folder. */
export async function createServerFromConfig(root: string): Promise<Started> {
  const config = new ConfigStore(join(root, "config.yml"));
  const loaded = await config.load();
  if (!loaded.ok) throw new Error(`Unreadable configuration: ${loaded.error}`);

  const db = openDatabase(join(root, "laneyard.db"));

  // No run that had begun can survive the shutdown of the process that carried
  // it. Queued runs never began, so they stay queued for the next start.
  new RunStore(db).interruptInFlight();

  const cache = new CacheStore(db);
  const vault = await Vault.open(root, new SecretStore(db), new CredentialStore(db));
  const app = await buildApp({
    config,
    db,
    root,
    vault,
    lanes: async (slug, workspacePath, fastlaneDir) => {
      const resolved = await config.resolve(slug, workspacePath);
      const reader = new LaneReader(cache, makeInvoke(resolved?.settings.runtime ?? "bundle"));
      return reader.read(slug, workspacePath, fastlaneDir);
    },
    uses: async (slug, workspacePath, fastlaneDir) => {
      const resolved = await config.resolve(slug, workspacePath);
      const reader = new UsesReader(cache, makeInvoke(resolved?.settings.runtime ?? "bundle"));
      return reader.read(slug, workspacePath, fastlaneDir);
    },
  });

  // Anything left queued from the previous life starts moving again now. Without
  // this, `wake()` would only ever be called from the trigger route, and three
  // runs queued before a restart would wait for someone to trigger a fourth.
  app.queue.wake();

  return { app, db, config };
}

/** Real startup, outside tests. */
async function main(): Promise<void> {
  const root = process.env["LANEYARD_HOME"] ?? join(homedir(), ".laneyard");
  const { app, config } = await createServerFromConfig(root);

  config.watch((ok) => {
    if (!ok) console.error(`Invalid configuration, the previous one stays active: ${config.lastError()}`);
  });

  const server = config.server()!;
  await app.listen({ port: server.port, host: server.bind });

  const projects = config.projects();
  process.stdout.write(
    heading(`laneyard ${version}`) +
      field("listening", `http://localhost:${server.port}`) +
      "\n" +
      field("config", join(root, "config.yml")) +
      "\n" +
      field(
        "projects",
        projects.length === 0
          ? dim("none yet")
          : projects.map((p) => p.slug).join(", "),
      ) +
      "\n" +
      (projects.length === 0
        ? // A server with nothing to build should say what to do next rather
          // than sit there looking successful.
          "\n" +
          dim("  No project yet. From a folder that already uses fastlane:\n") +
          `  ${bold("laneyard setup")}\n`
        : "") +
      "\n",
  );
}

/**
 * True when this file is what the user launched, rather than something that
 * imported it.
 *
 * Comparing real paths and not file names: installed globally, `laneyard` is a
 * symlink whose name has nothing to do with this file, and a check on "main.js"
 * would leave the command silently doing nothing.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const USAGE = `laneyard — a self-hosted web UI for fastlane

  laneyard setup      set up the project in the current directory
                      --yes accepts every detected value without asking
  laneyard secret set NAME [--project <slug>]
                      store a secret, its value read from standard input
  laneyard user add NAME [--role admin|builder]
                      create an account, its password read from standard input
  laneyard remove <slug>
                      remove one project and everything Laneyard holds for it
                      --dry-run shows what would go and stops
  laneyard reset      wipe the data, keeping the accounts and the vault key
                      --dry-run shows what would go and stops
  laneyard uninstall  remove Laneyard's data folder, after showing what is in it
                      --dry-run shows the inventory and stops
  laneyard            start the server
  laneyard --version  print the version

Configuration lives in ~/.laneyard/config.yml, or in $LANEYARD_HOME.
`;

function homeDir(): string {
  return process.env["LANEYARD_HOME"] ?? join(homedir(), ".laneyard");
}

/** Turns a startup failure into something a newcomer can act on. */
function explainStartupFailure(cause: unknown): string {
  const message = (cause as Error).message;
  if (message.includes("ENOENT") && message.includes("config.yml")) {
    return (
      "No configuration yet.\n\n" +
      "  cd into a project that already uses fastlane, then run:\n" +
      "    laneyard setup\n\n" +
      "That writes " + join(homeDir(), "config.yml") + " for you."
    );
  }
  return message;
}

if (invokedDirectly()) {
  const [, , command, ...rest] = process.argv;

  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }

  if (command === "setup") {
    const home = homeDir();
    await mkdir(home, { recursive: true });
    const slugIndex = rest.indexOf("--slug");
    const slug = slugIndex === -1 ? undefined : rest[slugIndex + 1];
    // `--yes` accepts every proposal, for scripts and for anyone who has done
    // this before. Interactive is the default because the values are guesses.
    const yes = rest.includes("--yes") || rest.includes("-y");
    try {
      process.exit(await runSetupCommand(process.cwd(), join(home, "config.yml"), { slug, yes }));
    } catch (cause) {
      // Ctrl-C in the middle of the questions. Nothing is written before the
      // last confirmation, so the only thing worth saying is that it is safe to
      // start over. 130 is what a shell expects from a command killed by SIGINT.
      if (cause instanceof PromptAborted) {
        process.stdout.write(`\n${dim("Setup interrupted — nothing was written. Run `laneyard setup` again.")}\n`);
        process.exit(130);
      }
      // A taken slug or an unreadable file are ordinary situations. A stack
      // trace is not an error message; it just suggests the tool is broken.
      process.stderr.write(`${(cause as Error).message}\n`);
      process.exit(1);
    }
  }

  // Above the catch-all below, which would otherwise reject it as unknown.
  if (command === "secret") {
    const home = homeDir();
    await mkdir(home, { recursive: true });
    process.exit(
      await runSecretCommand(home, rest, {
        stdin: process.stdin,
        interactive: process.stdin.isTTY === true,
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      }),
    );
  }

  if (command === "user") {
    const home = homeDir();
    await mkdir(home, { recursive: true });
    process.exit(
      await runUserCommand(home, rest, {
        stdin: process.stdin,
        interactive: process.stdin.isTTY === true,
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      }),
    );
  }

  // No `mkdir` here, unlike the commands above: this one asks what is there
  // and would look ridiculous creating the folder it is about to report on.
  if (command === "uninstall") {
    process.exit(
      await runUninstallCommand(homeDir(), rest, {
        stdin: process.stdin,
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      }),
    );
  }

  // No `mkdir` either: like `uninstall`, these read what is already there.
  if (command === "remove") {
    process.exit(
      await runRemoveCommand(homeDir(), rest, {
        stdin: process.stdin,
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      }),
    );
  }

  if (command === "reset") {
    process.exit(
      await runResetCommand(homeDir(), rest, {
        stdin: process.stdin,
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      }),
    );
  }

  // 0.1.0 shipped this as `add`. Anyone who learned that name deserves a
  // sentence rather than "Unknown command".
  if (command === "add") {
    process.stderr.write("`laneyard add` is now `laneyard setup`.\n");
    process.exit(1);
  }

  if (command !== undefined) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
  }

  main().catch((cause: unknown) => {
    process.stderr.write(`${explainStartupFailure(cause)}\n`);
    process.exit(1);
  });
}

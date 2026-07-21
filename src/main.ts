#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { runAddCommand } from "./cli/add.js";
import { runSecretCommand } from "./cli/secret.js";
import { ConfigStore } from "./config/store.js";
import { CacheStore } from "./db/cache.js";
import { openDatabase } from "./db/open.js";
import type { Db } from "./db/open.js";
import { RunStore } from "./db/runs.js";
import { SecretStore } from "./db/secrets.js";
import { buildApp } from "./server/app.js";
import { Vault } from "./secrets/vault.js";
import { makeInvoke } from "./sidecar/bridge.js";
import { LaneReader } from "./sidecar/lanes.js";
import { UsesReader } from "./sidecar/uses.js";

export const version = "0.2.0";

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
  const vault = await Vault.open(root, new SecretStore(db));
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
  console.log(`Laneyard is listening on http://localhost:${server.port}`);
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

  laneyard add        adopt the project in the current directory
  laneyard secret set NAME [--project <slug>]
                      store a secret, its value read from standard input
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
      "    laneyard add\n\n" +
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

  if (command === "add") {
    const home = homeDir();
    await mkdir(home, { recursive: true });
    const slugIndex = rest.indexOf("--slug");
    const slug = slugIndex === -1 ? undefined : rest[slugIndex + 1];
    try {
      process.exit(await runAddCommand(process.cwd(), join(home, "config.yml"), slug));
    } catch (cause) {
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

  if (command !== undefined) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
  }

  main().catch((cause: unknown) => {
    process.stderr.write(`${explainStartupFailure(cause)}\n`);
    process.exit(1);
  });
}

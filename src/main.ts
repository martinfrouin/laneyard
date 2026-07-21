import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { runAddCommand } from "./cli/add.js";
import { ConfigStore } from "./config/store.js";
import { CacheStore } from "./db/cache.js";
import { openDatabase } from "./db/open.js";
import type { Db } from "./db/open.js";
import { RunStore } from "./db/runs.js";
import { buildApp } from "./server/app.js";
import { makeInvoke } from "./sidecar/bridge.js";
import { LaneReader } from "./sidecar/lanes.js";

export const version = "0.1.0";

export interface Started {
  app: FastifyInstance;
  db: Db;
  config: ConfigStore;
}

/** Assemble le serveur à partir d'un dossier de données. */
export async function createServerFromConfig(root: string): Promise<Started> {
  const config = new ConfigStore(join(root, "config.yml"));
  const loaded = await config.load();
  if (!loaded.ok) throw new Error(`Configuration illisible : ${loaded.error}`);

  const db = openDatabase(join(root, "laneyard.db"));

  // Aucun run ne peut survivre à l'arrêt du processus qui le portait.
  new RunStore(db).interruptActive();

  const cache = new CacheStore(db);
  const app = await buildApp({
    config,
    db,
    root,
    lanes: async (slug, workspacePath, fastlaneDir) => {
      const resolved = await config.resolve(slug, workspacePath);
      const reader = new LaneReader(cache, makeInvoke(resolved?.settings.runtime ?? "bundle"));
      return reader.read(slug, workspacePath, fastlaneDir);
    },
  });

  return { app, db, config };
}

/** Démarrage réel, hors tests. */
async function main(): Promise<void> {
  const root = process.env["LANEYARD_HOME"] ?? join(homedir(), ".laneyard");
  const { app, config } = await createServerFromConfig(root);

  config.watch((ok) => {
    if (!ok) console.error(`Configuration invalide, l'ancienne reste active : ${config.lastError()}`);
  });

  const server = config.server()!;
  await app.listen({ port: server.port, host: server.bind });
  console.log(`Laneyard écoute sur http://localhost:${server.port}`);
}

if (process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js")) {
  const [, , command, ...rest] = process.argv;
  if (command === "add") {
    const home = process.env["LANEYARD_HOME"] ?? join(homedir(), ".laneyard");
    await mkdir(home, { recursive: true });
    const slugIndex = rest.indexOf("--slug");
    const slug = slugIndex === -1 ? undefined : rest[slugIndex + 1];
    process.exit(await runAddCommand(process.cwd(), join(home, "config.yml"), slug));
  } else {
    main().catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
  }
}

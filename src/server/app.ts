import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigStore } from "../config/store.js";
import type { Db } from "../db/open.js";
import { RunStore } from "../db/runs.js";
import { Workspace } from "../git/workspace.js";
import { LogStore } from "../logs/store.js";
import type { Lane } from "../sidecar/lanes.js";
import { SESSION_COOKIE, SessionStore, verifyPassword } from "./auth.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerWebSocket } from "./ws.js";
import type { RunSockets } from "./ws.js";

export interface AppDeps {
  config: ConfigStore;
  db: Db;
  /** Racine de données : workspaces, logs, artefacts. */
  root: string;
  /** Injecté pour que les tests n'aient pas besoin de Ruby ni de fastlane. */
  lanes: (slug: string, workspacePath: string, fastlaneDir: string) => Promise<Lane[]>;
}

export interface AppContext extends AppDeps {
  runs: RunStore;
  logs: LogStore;
  sessions: SessionStore;
  sockets?: RunSockets;
  workspacePath: (slug: string) => string;
  artifactsDir: (runId: number) => string;
  /** Clone le dépôt s'il ne l'est pas encore. Lève si le clone échoue. */
  ensureWorkspace: (slug: string) => Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    broadcastRunChunk?: (runId: number, chunk: string, offset: number) => void;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  const workspacePath = (slug: string) => join(deps.root, "workspaces", slug);

  const ctx: AppContext = {
    ...deps,
    runs: new RunStore(deps.db),
    logs: new LogStore(join(deps.root, "logs")),
    sessions: new SessionStore(),
    workspacePath,
    artifactsDir: (runId) => join(deps.root, "artifacts", String(runId)),
    ensureWorkspace: async (slug) => {
      const entry = deps.config.project(slug);
      if (!entry) throw new Error(`Projet inconnu : ${slug}`);
      await new Workspace(workspacePath(slug), entry.git_url, entry.git_auth).ensureCloned();
    },
  };

  app.post("/api/login", async (req, reply) => {
    const { password } = req.body as { password?: string };
    const hash = deps.config.server()?.password_hash;

    if (!password || !hash || !verifyPassword(password, hash)) {
      return reply.code(401).send({ error: "Mot de passe incorrect" });
    }

    const token = ctx.sessions.issue();
    return reply
      .setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax" })
      .send({ ok: true });
  });

  // Tout /api sauf /api/login exige une session.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api") || req.url === "/api/login") return;
    if (!ctx.sessions.valid(req.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: "Session requise" });
    }
  });

  ctx.sockets = await registerWebSocket(app, ctx);

  await registerProjectRoutes(app, ctx);
  await registerRunRoutes(app, ctx);

  // Résolue depuis l'emplacement du module, pas depuis le dossier de données :
  // `deps.root` est ~/.laneyard, la SPA construite vit dans le dépôt. Deux
  // positions relatives, selon qu'on tourne sur les sources (`src/server`) ou
  // sur le build (`dist/src/server`) ; toutes deux désignent `dist/web`, jamais
  // le dossier `web/` des sources dont l'`index.html` n'est pas construit.
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = [
    join(here, "..", "..", "dist", "web"),
    join(here, "..", "..", "..", "dist", "web"),
  ].find((candidate) => existsSync(join(candidate, "index.html")));

  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot });
    // Le routage vit côté navigateur : toute URL inconnue rend l'application.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) return reply.code(404).send({ error: "Route inconnue" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

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
import { LoginThrottle, SESSION_COOKIE, SessionStore, verifyPassword } from "./auth.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerWebSocket } from "./ws.js";
import type { RunSockets } from "./ws.js";

export interface AppDeps {
  config: ConfigStore;
  db: Db;
  /** Data root: workspaces, logs, artifacts. */
  root: string;
  /** Injected so tests don't need Ruby or fastlane. */
  lanes: (slug: string, workspacePath: string, fastlaneDir: string) => Promise<Lane[]>;
}

export interface AppContext extends AppDeps {
  runs: RunStore;
  logs: LogStore;
  sessions: SessionStore;
  sockets?: RunSockets;
  workspacePath: (slug: string) => string;
  artifactsDir: (runId: number) => string;
  /** Clones the repository if it isn't cloned yet. Throws if the clone fails. */
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
      if (!entry) throw new Error(`Unknown project: ${slug}`);
      await new Workspace(workspacePath(slug), entry.git_url, entry.git_auth).ensureCloned();
    },
  };

  const throttle = new LoginThrottle();

  app.post("/api/login", async (req, reply) => {
    const { password } = req.body as { password?: string };
    const hash = deps.config.server()?.password_hash;

    const waitMs = throttle.retryAfterMs();
    if (waitMs > 0) {
      return reply
        .code(429)
        .header("retry-after", Math.ceil(waitMs / 1000))
        .send({ error: `Too many attempts. Try again in ${Math.ceil(waitMs / 1000)}s.` });
    }

    if (!password || !hash || !(await verifyPassword(password, hash))) {
      throttle.recordFailure();
      return reply.code(401).send({ error: "Incorrect password" });
    }

    throttle.recordSuccess();
    const token = ctx.sessions.issue();
    return reply
      .setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax" })
      .send({ ok: true });
  });

  // Every /api route except /api/login requires a session.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api") || req.url === "/api/login") return;
    if (!ctx.sessions.valid(req.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: "Session required" });
    }
  });

  ctx.sockets = await registerWebSocket(app, ctx);

  await registerProjectRoutes(app, ctx);
  await registerRunRoutes(app, ctx);

  // Resolved from the module's location, not from the data folder:
  // `deps.root` is ~/.laneyard, the built SPA lives in the repository. Two
  // relative positions, depending on whether we're running on the sources
  // (`src/server`) or on the build (`dist/src/server`); both point to
  // `dist/web`, never the source `web/` folder whose `index.html` isn't built.
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = [
    join(here, "..", "..", "dist", "web"),
    join(here, "..", "..", "..", "dist", "web"),
  ].find((candidate) => existsSync(join(candidate, "index.html")));

  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot });
    // Routing lives on the browser side: any unknown URL renders the app.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) return reply.code(404).send({ error: "Unknown route" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

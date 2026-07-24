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
import { SessionRecords } from "../db/sessions.js";
import { Workspace } from "../git/workspace.js";
import { LogStore } from "../logs/store.js";
import { materialiseCredentials } from "../runner/materialise.js";
import type { MaterialisedCredentials } from "../runner/materialise.js";
import { executeRun } from "../runner/orchestrate.js";
import { RunQueue } from "../runner/queue.js";
import type { Lane } from "../sidecar/lanes.js";
import type { FastfileUses } from "../sidecar/uses.js";
import type { Vault } from "../secrets/vault.js";
import { authenticate, LoginThrottle, COOKIE_OPTIONS, SESSION_COOKIE, SessionStore } from "./auth.js";
import type { Identity } from "./auth.js";
import { accountMayReach, projectSlugOfRequest, requiresAdmin } from "./permissions.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerFastfileRoutes } from "./routes/fastfile.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerReadinessRoutes } from "./routes/readiness.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSecretRoutes } from "./routes/secrets.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerWebSocket } from "./ws.js";
import type { RunSockets } from "./ws.js";

export interface AppDeps {
  config: ConfigStore;
  db: Db;
  /** Data root: workspaces, logs, artifacts. */
  root: string;
  /** Injected so tests don't need Ruby or fastlane. */
  lanes: (slug: string, workspacePath: string, fastlaneDir: string) => Promise<Lane[]>;
  /** What each lane calls, for the readiness checklist. Injected for the same reason. */
  uses: (slug: string, workspacePath: string, fastlaneDir: string) => Promise<FastfileUses>;
  /** The sole holder of plaintext secrets. Built async, so it's assembled outside `buildApp`. */
  vault: Vault;
}

export interface AppContext extends AppDeps {
  runs: RunStore;
  logs: LogStore;
  sessions: SessionStore;
  sockets?: RunSockets;
  workspacePath: (slug: string) => string;
  artifactsDir: (runId: number) => string;
  /**
   * Where a run's signing blocks are written, and deleted from when it ends.
   *
   * Next to `artifacts/<run id>` rather than inside the clone: the workspace is
   * kept between runs and lanes commit and push from it, so a keystore dropped
   * in there would both dirty a tree the project owns and stay on disk long
   * after the run that needed it.
   */
  runSecretsDir: (runId: number) => string;
  /** Clones the repository if it isn't cloned yet. Throws if the clone fails. */
  ensureWorkspace: (slug: string) => Promise<void>;
  /** The single worker. Routes ring its bell; they never run anything themselves. */
  /**
   * Set immediately after the context is built. Optional in the type rather than
   * cast into existence: a lie in a type is worth less than a `?` at the two
   * call sites that read it.
   */
  queue?: RunQueue;
}

declare module "fastify" {
  interface FastifyInstance {
    broadcastRunChunk?: (runId: number, chunk: string, offset: number) => void;
    /**
     * Always present once `buildApp` has returned — which is the only way anyone
     * gets a `FastifyInstance` here. Required on the instance, optional on the
     * internal context, because that is exactly where the difference lies.
     */
    queue: RunQueue;
  }

  interface FastifyRequest {
    /**
     * Who is making this request. Set by the session hook, so it is present on
     * every `/api` route except `/api/login` — and optional in the type because
     * that exception is real.
     */
    identity?: Identity;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  // Declared up front so every request carries the field on the same shape,
  // rather than each one growing a property the first time a hook writes it.
  app.decorateRequest("identity", undefined);

  const workspacePath = (slug: string) => join(deps.root, "workspaces", slug);

  const ctx: AppContext = {
    ...deps,
    runs: new RunStore(deps.db),
    logs: new LogStore(join(deps.root, "logs")),
    sessions: new SessionStore(new SessionRecords(deps.db)),
    workspacePath,
    artifactsDir: (runId) => join(deps.root, "artifacts", String(runId)),
    runSecretsDir: (runId) => join(deps.root, "runs", String(runId), "secrets"),
    ensureWorkspace: async (slug) => {
      const entry = deps.config.project(slug);
      if (!entry) throw new Error(`Unknown project: ${slug}`);
      await new Workspace(workspacePath(slug), entry.git_url, entry.git_auth).ensureCloned();
    },
  };

  // The queue is assembled here rather than in `createServerFromConfig`: its job
  // needs `runs`, `logs`, the workspace and artifact paths and the sockets, none
  // of which exist before `ctx` does. It is assigned after the context literal
  // because the job it drives closes over that very context — hence the field
  // being optional in the type rather than a cast pretending it is already set.
  ctx.queue = new RunQueue(ctx.runs, async (runId, signal) => {
    const run = ctx.runs.get(runId);
    if (!run) return;
    const slug = run.projectSlug;
    const entry = deps.config.project(slug);
    if (!entry) {
      // The project was removed from config.yml while this run waited. Ending it
      // here is what keeps the queue from re-reading the same row for ever.
      ctx.runs.finish(runId, {
        status: "failed",
        exitCode: null,
        errorSummary: `Project "${slug}" is no longer in the configuration`,
      });
      return;
    }

    // Before the run, and outside it: `executeRun` is handed plaintext and
    // never the vault, a boundary worth more than the convenience of moving
    // this one call inside. A block that will not decrypt stops the run here,
    // with the reason, rather than producing an artifact signed by nothing.
    let credentials: MaterialisedCredentials;
    try {
      credentials = await materialiseCredentials(ctx.vault, slug, ctx.runSecretsDir(runId));
    } catch (cause) {
      ctx.runs.finish(runId, {
        status: "failed",
        exitCode: null,
        errorSummary: ctx.vault.scrub(slug, (cause as Error).message),
      });
      ctx.sockets?.finish(runId, "failed");
      return;
    }

    await executeRun({
      runId,
      runs: ctx.runs,
      logs: ctx.logs,
      workspacePath: ctx.workspacePath(slug),
      artifactsDir: ctx.artifactsDir(runId),
      gitUrl: entry.git_url,
      gitAuth: entry.git_auth,
      branch: entry.default_branch,
      // Resolved after the clone, once the repository's laneyard.yml is finally readable.
      resolveSettings: async () => {
        const r = await ctx.config.resolve(slug, ctx.workspacePath(slug));
        return r!.settings;
      },
      env: process.env,
      secrets: ctx.vault.resolve(slug),
      // A subset of the line above, not a second source. The tick decides which
      // variables are also written into the file the build reads from disk;
      // every one of them still reaches the run through the environment.
      envFileValues: ctx.vault.envFileValues(slug),
      credentialEnv: credentials.env,
      androidKeystore: credentials.keystore,
      cleanup: credentials.cleanup,
      maskedValues: ctx.vault.maskedValues(slug),
      signal,
      onChunk: (chunk, offset) => app.broadcastRunChunk?.(runId, chunk, offset),
    })
      .then((r) => ctx.sockets?.finish(runId, r.status))
      .catch((cause: unknown) => {
        // Last safety net. `executeRun` commits to never throwing, but the queue
        // cannot afford to depend on that: a run left neither finished nor
        // failed is a row the interface polls until someone gives up.
        ctx.runs.finish(runId, {
          status: "failed",
          exitCode: null,
          errorSummary: ctx.vault.scrub(slug, `Unexpected failure: ${(cause as Error).message}`),
        });
        ctx.sockets?.finish(runId, "failed");
      });
  });

  // `ctx.queue` is assigned immediately above; naming it here rather than
  // reaching through the optional field is what lets every route treat the
  // queue as simply present.
  const queue = ctx.queue;
  app.decorate("queue", queue);

  // A closed server must stop taking new work: the run in flight is left to
  // finish, but nothing behind it starts on a server nobody is listening to.
  app.addHook("onClose", async () => queue.close());

  const throttle = new LoginThrottle();

  app.post("/api/login", async (req, reply) => {
    const { name, password } = (req.body ?? {}) as { name?: string; password?: string };

    const waitMs = name ? throttle.retryAfterMs(name) : 0;
    if (waitMs > 0) {
      return reply
        .code(429)
        .header("retry-after", Math.ceil(waitMs / 1000))
        .send({ error: `Too many attempts. Try again in ${Math.ceil(waitMs / 1000)}s.` });
    }

    const users = deps.config.server()?.users ?? [];
    const identity = name && password ? await authenticate(users, name, password) : null;
    if (!identity) {
      if (name) throttle.recordFailure(name);
      // One message for a wrong password and for a name that does not exist:
      // telling them apart is telling a stranger which accounts are worth
      // attacking.
      return reply.code(401).send({ error: "Incorrect name or password" });
    }

    throttle.recordSuccess(identity.name);
    const token = ctx.sessions.issue(identity);
    return reply
      .setCookie(SESSION_COOKIE, token, COOKIE_OPTIONS)
      .send({ ok: true, name: identity.name, role: identity.role });
  });

  // Every /api route except /api/login requires a session, and the routes on
  // the admin list require an admin. Both decided here, once: a permission
  // expressed as an `if` inside a handler is one nobody finds during an audit.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api") || req.url.split("?")[0] === "/api/login") return;

    const session = ctx.sessions.get(req.cookies[SESSION_COOKIE]);
    // The session holds who someone was when they signed in; the configuration
    // holds who they are. They part company whenever config.yml is edited —
    // from `laneyard user add`, which is another process entirely, or by hand.
    // So the account is looked up again on every request: an account that is
    // gone has no session, and a demotion takes effect at once rather than at
    // the next restart. It is one find over a handful of entries.
    const account = session && ctx.config.server()?.users.find((u) => u.name === session.name);
    if (!session || !account) {
      return reply.code(401).send({ error: "Session required" });
    }
    const identity = { name: account.name, role: account.role };
    req.identity = identity;

    if (identity.role !== "admin" && requiresAdmin(req.method, req.url)) {
      return reply.code(403).send({ error: "This action requires the admin role" });
    }

    // Per-project reach, for a non-admin only: a project this account may not
    // reach is invisible, not shown-and-locked, so it answers 404 with the very
    // body a genuinely unknown project gives. A 403 would confirm the project
    // exists. The slug is resolved here, in the one hook, rather than in each
    // run and project handler — the same reason `requiresAdmin` lives here.
    if (identity.role !== "admin") {
      const slug = projectSlugOfRequest(req.url, (id) => ctx.runs.get(id)?.projectSlug ?? null);
      if (slug !== null && !accountMayReach(account, slug)) {
        return reply.code(404).send({ error: "Unknown project" });
      }
    }
  });

  /**
   * Signing out ends this session and no other.
   *
   * The same person may be signed in on a laptop and on a phone; pressing sign
   * out on one of them must not be an act on the other. Only removing the
   * account ends every session it has, and that is a different action with a
   * different name.
   */
  app.post("/api/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) ctx.sessions.revoke(token);
    return reply.clearCookie(SESSION_COOKIE, { path: "/" }).code(204).send();
  });

  app.get("/api/me", async (req) => {
    // Non-null because the hook above rejected every request that has no
    // identity before this handler could be reached.
    const { name, role } = req.identity!;
    return { name, role };
  });

  ctx.sockets = await registerWebSocket(app, ctx);

  await registerProjectRoutes(app, ctx);
  await registerRunRoutes(app, ctx);
  await registerSecretRoutes(app, ctx);
  await registerCredentialRoutes(app, ctx);
  await registerReadinessRoutes(app, ctx);
  await registerFastfileRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerAccountRoutes(app, ctx);

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

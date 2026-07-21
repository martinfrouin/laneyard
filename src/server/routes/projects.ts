import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";

export async function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/projects", async () =>
    ctx.config.projects().map((p) => {
      const last = ctx.runs.listByProject(p.slug, 1)[0] ?? null;
      return {
        slug: p.slug,
        name: p.name,
        color: p.color,
        lastRun: last && { id: last.id, status: last.status, lane: last.lane, finishedAt: last.finishedAt },
      };
    }),
  );

  app.get("/api/projects/:slug/lanes", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });

    try {
      // Lanes live in the repository: with no clone, there's nothing to read.
      // A freshly declared project must be usable without launching a run blind.
      await ctx.ensureWorkspace(slug);
      const resolved = await ctx.config.resolve(slug, ctx.workspacePath(slug));
      return await ctx.lanes(slug, ctx.workspacePath(slug), resolved!.settings.fastlane_dir);
    } catch (cause) {
      // Workspace not cloned yet, broken Fastfile, sidecar failure: the
      // interface must be able to tell the user, rather than show an empty list.
      return reply.code(503).send({ error: (cause as Error).message });
    }
  });

  app.get("/api/projects/:slug/runs", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    // The whole line is read once and the positions are looked up in it, rather
    // than asking the database where each of fifty runs stands. The position is
    // the global one: the queue is shared by every project.
    const line = ctx.runs.queued().map((r) => r.id);
    return ctx.runs.listByProject(slug).map((run) => {
      const at = line.indexOf(run.id);
      return { ...run, queuePosition: at === -1 ? null : at + 1 };
    });
  });
}

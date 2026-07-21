import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import type { AppContext } from "../app.js";
import type { RunStatus } from "../../db/runs.js";

/** Statuses a run can still be cancelled from. */
const CANCELLABLE: RunStatus[] = ["queued", "preparing", "running"];

export async function registerRunRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/api/projects/:slug/runs", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as { lane?: string; platform?: string | null; params?: Record<string, string> };

    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });
    if (!body.lane) return reply.code(400).send({ error: "Missing lane" });

    // We check that the lane genuinely exists before creating a run doomed to fail.
    try {
      await ctx.ensureWorkspace(slug);
      const resolved = await ctx.config.resolve(slug, ctx.workspacePath(slug));
      const lanes = await ctx.lanes(slug, ctx.workspacePath(slug), resolved!.settings.fastlane_dir);
      if (!lanes.some((l) => l.name === body.lane)) {
        return reply.code(400).send({ error: `Unknown lane: ${body.lane}` });
      }
    } catch {
      // Unreadable lanes: we let it through, the run will fail with a clear message.
    }

    const id = ctx.runs.create({
      projectSlug: slug,
      lane: body.lane,
      platform: body.platform ?? null,
      params: body.params ?? {},
    });

    // Read before the queue is woken, so the answer describes the line the
    // caller just joined rather than one the worker has already moved on from.
    const queuePosition = ctx.runs.queuePosition(id);

    // The route creates a row and rings the bell; the worker does the rest.
    app.queue.wake();

    return reply.code(201).send({ id, queuePosition });
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const run = ctx.runs.get(id);
    if (!run) return reply.code(404).send({ error: "Unknown run" });
    return {
      ...run,
      queuePosition: ctx.runs.queuePosition(id),
      steps: ctx.runs.steps(id),
      artifacts: ctx.runs.artifacts(id),
    };
  });

  app.post("/api/runs/:id/cancel", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const run = ctx.runs.get(id);
    if (!run) return reply.code(404).send({ error: "Unknown run" });
    if (!CANCELLABLE.includes(run.status)) {
      return reply.code(409).send({ error: `Run #${id} has already finished` });
    }

    // A queued run is finished on the spot; a running one is signalled and ends
    // a few moments later. Either way the caller has nothing left to wait for.
    app.queue.cancel(id);
    return reply.code(204).send();
  });

  app.get("/api/runs/:id/log", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const from = Number((req.query as { from?: string }).from ?? 0);
    if (!ctx.runs.get(id)) return reply.code(404).send({ error: "Unknown run" });
    return reply.type("text/plain; charset=utf-8").send(await ctx.logs.read(id, from));
  });

  app.get("/api/runs/:id/artifacts/:artifactId", async (req, reply) => {
    const { id, artifactId } = req.params as { id: string; artifactId: string };
    const artifact = ctx.runs.artifacts(Number(id)).find((a) => a.id === Number(artifactId));
    if (!artifact) return reply.code(404).send({ error: "Unknown artifact" });

    return reply
      // A file from the repository can carry a quote in its name: without
      // escaping it would break the header.
      .header(
        "Content-Disposition",
        `attachment; filename="${artifact.filename.replace(/["\\]/g, "_")}"`,
      )
      .type("application/octet-stream")
      .send(createReadStream(artifact.path));
  });
}

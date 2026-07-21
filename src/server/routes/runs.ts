import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import type { AppContext } from "../app.js";
import { executeRun } from "../../runner/orchestrate.js";

export async function registerRunRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/api/projects/:slug/runs", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as { lane?: string; platform?: string | null; params?: Record<string, string> };

    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });
    if (!body.lane) return reply.code(400).send({ error: "Missing lane" });

    // Only one run at a time per project: they share the same git workspace.
    // Two concurrent runs would silently trip over each other — one would
    // change the commit out from under the other, carry off its artifacts
    // and delete its report. The real queue comes at the next milestone;
    // this refusal, for its part, already prevents false results.
    const last = ctx.runs.listByProject(slug, 1)[0];
    if (last && ["queued", "preparing", "running"].includes(last.status)) {
      return reply.code(409).send({
        error: `Run #${last.id} is still in progress on this project. Wait for it to finish.`,
      });
    }

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

    // Launched without waiting: the HTTP response mustn't take as long as a build.
    void executeRun({
      runId: id,
      runs: ctx.runs,
      logs: ctx.logs,
      workspacePath: ctx.workspacePath(slug),
      artifactsDir: ctx.artifactsDir(id),
      gitUrl: entry.git_url,
      gitAuth: entry.git_auth,
      branch: entry.default_branch,
      // Resolved after the clone, once the repository's laneyard.yml is finally readable.
      resolveSettings: async () => {
        const r = await ctx.config.resolve(slug, ctx.workspacePath(slug));
        return r!.settings;
      },
      env: process.env,
      onChunk: (chunk, offset) => app.broadcastRunChunk?.(id, chunk, offset),
    })
      .then((r) => ctx.sockets?.finish(id, r.status))
      .catch((cause: unknown) => {
        // Last safety net. `executeRun` commits to never throwing, but a
        // rejected promise with no handler brings down the whole Node
        // process — and with it, the other runs in progress. The cost of
        // forgetting this would be disproportionate.
        ctx.runs.finish(id, {
          status: "failed",
          exitCode: null,
          errorSummary: `Unexpected failure: ${(cause as Error).message}`,
        });
        ctx.sockets?.finish(id, "failed");
      });

    return reply.code(201).send({ id });
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const run = ctx.runs.get(id);
    if (!run) return reply.code(404).send({ error: "Unknown run" });
    return { ...run, steps: ctx.runs.steps(id), artifacts: ctx.runs.artifacts(id) };
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

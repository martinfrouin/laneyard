import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import type { AppContext } from "../app.js";
import { executeRun } from "../../runner/orchestrate.js";

export async function registerRunRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/api/projects/:slug/runs", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as { lane?: string; platform?: string | null; params?: Record<string, string> };

    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Projet inconnu" });
    if (!body.lane) return reply.code(400).send({ error: "Lane manquante" });

    // On vérifie que la lane existe vraiment avant de créer un run voué à l'échec.
    try {
      await ctx.ensureWorkspace(slug);
      const resolved = await ctx.config.resolve(slug, ctx.workspacePath(slug));
      const lanes = await ctx.lanes(slug, ctx.workspacePath(slug), resolved!.settings.fastlane_dir);
      if (!lanes.some((l) => l.name === body.lane)) {
        return reply.code(400).send({ error: `Lane inconnue : ${body.lane}` });
      }
    } catch {
      // Lanes illisibles : on laisse passer, le run échouera avec un message clair.
    }

    const id = ctx.runs.create({
      projectSlug: slug,
      lane: body.lane,
      platform: body.platform ?? null,
      params: body.params ?? {},
    });

    // Lancé sans attendre : la réponse HTTP ne doit pas durer le temps d'un build.
    void executeRun({
      runId: id,
      runs: ctx.runs,
      logs: ctx.logs,
      workspacePath: ctx.workspacePath(slug),
      artifactsDir: ctx.artifactsDir(id),
      gitUrl: entry.git_url,
      gitAuth: entry.git_auth,
      branch: entry.default_branch,
      // Résolus après le clone, quand le laneyard.yml du dépôt est enfin lisible.
      resolveSettings: async () => {
        const r = await ctx.config.resolve(slug, ctx.workspacePath(slug));
        return r!.settings;
      },
      env: process.env,
      onChunk: (chunk, offset) => app.broadcastRunChunk?.(id, chunk, offset),
    });

    return reply.code(201).send({ id });
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const run = ctx.runs.get(id);
    if (!run) return reply.code(404).send({ error: "Run inconnu" });
    return { ...run, steps: ctx.runs.steps(id), artifacts: ctx.runs.artifacts(id) };
  });

  app.get("/api/runs/:id/log", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const from = Number((req.query as { from?: string }).from ?? 0);
    if (!ctx.runs.get(id)) return reply.code(404).send({ error: "Run inconnu" });
    return reply.type("text/plain; charset=utf-8").send(await ctx.logs.read(id, from));
  });

  app.get("/api/runs/:id/artifacts/:artifactId", async (req, reply) => {
    const { id, artifactId } = req.params as { id: string; artifactId: string };
    const artifact = ctx.runs.artifacts(Number(id)).find((a) => a.id === Number(artifactId));
    if (!artifact) return reply.code(404).send({ error: "Artefact inconnu" });

    return reply
      .header("Content-Disposition", `attachment; filename="${artifact.filename}"`)
      .type("application/octet-stream")
      .send(createReadStream(artifact.path));
  });
}

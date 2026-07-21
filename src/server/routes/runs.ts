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

    // Un seul run à la fois par projet : ils partagent le même workspace git.
    // Deux runs concurrents se marcheraient dessus en silence — l'un changerait
    // de commit sous les pieds de l'autre, emporterait ses artefacts et
    // supprimerait son rapport. La vraie file d'attente vient au jalon suivant ;
    // ce refus, lui, empêche dès maintenant des résultats faux.
    const last = ctx.runs.listByProject(slug, 1)[0];
    if (last && ["queued", "preparing", "running"].includes(last.status)) {
      return reply.code(409).send({
        error: `Le run #${last.id} est encore en cours sur ce projet. Attendez sa fin.`,
      });
    }

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
    })
      .then((r) => ctx.sockets?.finish(id, r.status))
      .catch((cause: unknown) => {
        // Dernier filet. `executeRun` s'engage à ne pas lever, mais une promesse
        // rejetée sans gestionnaire abat tout le processus Node — et avec lui
        // les autres runs en cours. Le prix d'un oubli serait démesuré.
        ctx.runs.finish(id, {
          status: "failed",
          exitCode: null,
          errorSummary: `Échec inattendu : ${(cause as Error).message}`,
        });
        ctx.sockets?.finish(id, "failed");
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
      // Un fichier du dépôt peut porter un guillemet dans son nom : sans
      // échappement il casserait l'en-tête.
      .header(
        "Content-Disposition",
        `attachment; filename="${artifact.filename.replace(/["\\]/g, "_")}"`,
      )
      .type("application/octet-stream")
      .send(createReadStream(artifact.path));
  });
}

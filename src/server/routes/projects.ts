import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { removeProjectFromConfig } from "../../cli/setup.js";

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

  /**
   * Removes everything Laneyard holds for a project, in one confirmed act.
   *
   * It is the destructive route in the product, and it is destructive on
   * purpose. The block leaves config.yml, through the YAML document so the rest
   * of a hand-written file is untouched; the clone is deleted; every artifact
   * folder goes; the run history — the rows and their logs — is deleted; and
   * the project's own secrets and signing blocks are forgotten from the vault.
   * The history is the one thing here that cannot be made again, which is why
   * the whole act is behind a slug typed back rather than a click.
   *
   * What it still does not reach, and why each is out of scope:
   *
   *  - the git remote. The repository is on GitHub and on the user's disk. It
   *    is theirs, not Laneyard's, and nothing here reads or writes it.
   *  - the credential originals. Laneyard removes its own encrypted copy of a
   *    `.p8` or a keystore; the file that went in is still in the password
   *    manager or the safe it came from. The answer says so, the way
   *    `uninstall` does, so nobody is left thinking their keystore is gone.
   *  - global secrets and global signing blocks. They are read by every project
   *    on the machine, not this one's to take — `vault.forget` touches only
   *    slug-scoped rows, and the answer counts the global ones it left alone.
   *
   * The confirmation is the project's own slug, sent back as `?confirm=`.
   * Without a match nothing is removed: a bare DELETE is a refusal, not a
   * deletion. This is the gate `laneyard uninstall` uses for the same reason —
   * the one irreversible thing must not be reachable by a reflex.
   */
  app.delete("/api/projects/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { confirm } = req.query as { confirm?: string };
    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });

    // The slug typed back is the confirmation. This deletes the run history,
    // which nothing can rebuild, so a request that does not carry the slug
    // removes nothing and says why.
    if (confirm !== slug) {
      return reply.code(400).send({
        error: `Removing "${slug}" deletes its runs, its clone, its artifacts and its stored secrets, and cannot be undone. Send the project's slug as confirmation to remove it. Nothing was removed.`,
      });
    }

    // A run that has begun is reading the workspace this project points at.
    // Queued runs are not: the queue already fails a run whose project went
    // away, so waiting on them would only mean refusing for longer.
    if (ctx.runs.hasActiveRun(slug)) {
      return reply.code(409).send({
        error: `"${slug}" has a run in flight. Wait for it to finish, or cancel it, then remove the project.`,
      });
    }

    // Read before anything is touched. -1 is SQLite's "no limit": every run of
    // this project, because each one names an artifact folder and a log file to
    // remove. The global counts are read now too — the last moment anyone is
    // looking — so the answer can say what it left alone.
    const runs = ctx.runs.listByProject(slug, -1);
    const globalSecrets = ctx.vault.listGlobal().length;
    const globalSigningBlocks = ctx.vault.listGlobalCredentials().length;

    // The config block first: once it is gone the project cannot be started, so
    // nothing new begins reading the files the rest of this is about to remove.
    const removed = await removeProjectFromConfig(ctx.config.configPath(), slug);
    if (!removed) return reply.code(404).send({ error: "Unknown project" });
    // The file is watched, but on a debounce: reloading here is what makes the
    // very next request — the listing this page is about to ask for — truthful.
    await ctx.config.load();

    // The clone.
    const workspace = ctx.workspacePath(slug);
    const workspaceRemoved = existsSync(workspace);
    await rm(workspace, { recursive: true, force: true });

    // The artifacts and the logs, one of each per run that produced them.
    let artifactsRemoved = 0;
    for (const run of runs) {
      const dir = ctx.artifactsDir(run.id);
      if (existsSync(dir)) artifactsRemoved += 1;
      await rm(dir, { recursive: true, force: true });
      await ctx.logs.remove(run.id);
    }

    // The run history: the rows, and their steps and artifact records by cascade.
    ctx.runs.removeByProject(slug);

    // The project's own secrets and signing blocks. Slug-scoped only: a global
    // secret three other projects read is not this one's to take.
    const forgotten = ctx.vault.forget(slug);

    // A later change will strip this slug from every account's access grants.
    // That is one more "forget for this slug" step, and it belongs right here.

    return reply.send({
      slug,
      name: entry.name,
      removed: {
        runs: runs.length,
        artifacts: artifactsRemoved,
        workspace: workspaceRemoved,
        secrets: forgotten.secrets,
        signingBlocks: forgotten.credentials,
      },
      // Named, not removed. The git remote and the credential originals are the
      // user's and are never touched here; the global rows are shared by every
      // project and survive one of them going away.
      untouched: {
        globalSecrets,
        globalSigningBlocks,
      },
    });
  });

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

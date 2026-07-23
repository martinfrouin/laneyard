import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { removeProjectData } from "../../data/remove-project.js";

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

    // The global counts are read now — the last moment anyone is looking — so
    // the answer can say what it left alone. They are shared by every project
    // and survive one of them going away, which is why the removal never takes
    // them and the reply names them apart.
    const globalSecrets = ctx.vault.listGlobal().length;
    const globalSigningBlocks = ctx.vault.listGlobalCredentials().length;

    // The removal itself lives in one place, shared with `laneyard remove`: the
    // route confirms and shapes the reply, the core does the deleting.
    const result = await removeProjectData(
      {
        configPath: ctx.config.configPath(),
        // The file is watched, but on a debounce: reloading here is what makes
        // the very next request — the listing this page is about to ask for —
        // truthful.
        reloadConfig: () => ctx.config.load(),
        runs: ctx.runs,
        logs: ctx.logs,
        vault: ctx.vault,
        workspacePath: ctx.workspacePath,
        artifactsDir: ctx.artifactsDir,
      },
      slug,
    );
    if (!result.found) return reply.code(404).send({ error: "Unknown project" });

    // A later change will strip this slug from every account's access grants.
    // That is one more "forget for this slug" step, and it belongs in the core.

    return reply.send({
      slug,
      name: entry.name,
      removed: {
        runs: result.runs,
        artifacts: result.artifacts,
        workspace: result.workspace,
        secrets: result.secrets,
        signingBlocks: result.signingBlocks,
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

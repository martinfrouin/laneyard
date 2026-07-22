import { existsSync } from "node:fs";
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
   * Stops showing a project. It is the one destructive route in the product,
   * and what it does not destroy is most of the point:
   *
   *  - the project's block leaves config.yml, through the YAML document so the
   *    rest of a hand-written file is untouched;
   *  - its runs stay in the database, still reachable at their own URL — the
   *    history of what this machine built is not the project's to take away;
   *  - the clone and the artifacts stay on disk, named in the answer so they
   *    can be removed by hand. Deleting files someone may still want, from a
   *    web page, on one click, is not a thing to do;
   *  - its secrets and its signing blocks stay in the vault, counted in the
   *    answer. They are the one thing here that cannot be looked at from the
   *    interface — no route ever sends a credential back — so if this does not
   *    say they are there, nothing ever will. They are also scoped by slug: a
   *    project set up later under the same name would find the old keystore
   *    waiting for it, and sign with a credential nobody uploaded. Removing
   *    them is `DELETE /api/projects/:slug/vault`, below, and it is a second
   *    act on purpose.
   */
  app.delete("/api/projects/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });

    // A run that has begun is reading the workspace this project points at.
    // Queued runs are not: the queue already fails a run whose project went
    // away, so waiting on them would only mean refusing for longer.
    if (ctx.runs.hasActiveRun(slug)) {
      return reply.code(409).send({
        error: `"${slug}" has a run in flight. Wait for it to finish, or cancel it, then remove the project.`,
      });
    }

    const removed = await removeProjectFromConfig(ctx.config.configPath(), slug);
    if (!removed) return reply.code(404).send({ error: "Unknown project" });

    // The file is watched, but on a debounce: reloading here is what makes the
    // very next request — the listing this page is about to ask for — truthful.
    await ctx.config.load();

    // -1 is SQLite's "no limit": the answer names every artifact folder left
    // behind, and a project with sixty runs must not be told about fifty of them.
    const runs = ctx.runs.listByProject(slug, -1);
    const leftOnDisk = [
      ctx.workspacePath(slug),
      ...runs.map((run) => ctx.artifactsDir(run.id)),
    ].filter((path) => existsSync(path));

    // Counted after the block is gone, and read from the vault rather than
    // inferred: the two stores are the only thing that knows, and this is the
    // last moment anyone is looking.
    const owned = ctx.vault.ownedBy(slug);
    return reply.send({
      slug,
      name: entry.name,
      runsKept: runs.length,
      leftOnDisk,
      vaultKept: {
        secrets: owned.secrets.length,
        signingBlocks: owned.credentials.length,
        // Named separately because they are not this project's to lose. A
        // global secret is read by every project on the machine, and an answer
        // that folded them into one number would invite removing them.
        globalSecrets: ctx.vault.listGlobal().length,
        globalSigningBlocks: ctx.vault.listGlobalCredentials().length,
      },
    });
  });

  /**
   * Removes what the vault still holds under a removed project's name.
   *
   * Deliberately not part of removing the project. That route destroys nothing,
   * and the reason is the one this route has to earn instead: a signing block
   * cannot be read back out of Laneyard — the `.p8` and the keystore that went
   * in are the only copies it ever had — so deleting one on the same click that
   * hides a project from a list would be destroying something unrecoverable as
   * a side effect of tidying up.
   *
   * Refused while the slug is still a project, so this can only ever be the
   * clean-up after a removal. A live project's secrets and blocks are removed
   * one at a time, from the tabs that show them, where the user can see what
   * each one is.
   *
   * Only rows carrying this slug go. A global secret and a global signing block
   * are shared by every project and survive it.
   */
  app.delete("/api/projects/:slug/vault", async (req, reply) => {
    const { slug } = req.params as { slug: string };

    if (ctx.config.project(slug)) {
      return reply.code(409).send({
        error: `"${slug}" is still a project on this machine. Remove the project first, or remove its secrets and signing blocks one at a time from its own tabs.`,
      });
    }

    const removed = ctx.vault.forget(slug);
    return reply.send({
      slug,
      secretsRemoved: removed.secrets,
      signingBlocksRemoved: removed.credentials,
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

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { accountMayReach } from "../permissions.js";
import { Workspace } from "../../git/workspace.js";
import { removeProjectData } from "../../data/remove-project.js";

export async function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // The listing every account is shown, filtered to what it may reach. This is
  // the source of the invisibility the interface shows — the nav and the project
  // list are driven by it, so a filtered response filters the UI with no change
  // beyond what the data carries. The account is looked up fresh, the way the
  // auth hook does, because config.yml is the truth on every request. An admin,
  // and a builder with no `projects` field, are served every project.
  app.get("/api/projects", async (req) => {
    const account = ctx.config.server()?.users.find((u) => u.name === req.identity!.name);
    return ctx.config
      .projects()
      .filter((p) => account !== undefined && accountMayReach(account, p.slug))
      .map((p) => {
        const last = ctx.runs.listByProject(p.slug, 1)[0] ?? null;
        return {
          slug: p.slug,
          name: p.name,
          color: p.color,
          lastRun: last && { id: last.id, status: last.status, lane: last.lane, finishedAt: last.finishedAt },
        };
      });
  });

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
        buildNumbers: ctx.buildNumbers,
        logs: ctx.logs,
        vault: ctx.vault,
        workspacePath: ctx.workspacePath,
        artifactsDir: ctx.artifactsDir,
      },
      slug,
    );
    if (!result.found) return reply.code(404).send({ error: "Unknown project" });

    // The slug is also stripped from every account's access grants, in the core
    // beside the other "forget for this slug" steps: a grant pointing at a
    // project that no longer exists is dead data, and a project re-created later
    // under the same slug must not silently inherit an old grant.

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

  /**
   * Brings the clone up to the remote, without building anything.
   *
   * Everything that reads the repository outside a run — the lanes, the
   * checklist, the names a lane is missing — goes through `ensureCloned`, which
   * does nothing at all once the directory exists. Only a run fetched. So a
   * project whose first run failed early answered from that first commit
   * indefinitely, and the screens said so with the confidence of something just
   * looked up: a variable a Fastfile had stopped reading was still asked for,
   * days after the commit that stopped reading it.
   *
   * Deliberately not a fetch hidden inside those reads. Going out to a git
   * remote is seconds and a network, and putting it behind opening a tab would
   * make every one of them slow and occasionally fail for a reason that has
   * nothing to do with what was asked. It is a button, and this is what it
   * presses.
   *
   * `prepare` and not a bare fetch: the point is to show what the next run would
   * see, and `prepare` is exactly what the next run calls. It clones when there
   * is nothing yet, which makes the button a way in for a project between
   * `setup` and its first build rather than a refusal.
   *
   * Not admin-only. A builder starts runs, and a run fetches — refusing them the
   * same fetch on its own would protect nothing.
   */
  app.post("/api/projects/:slug/fetch", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });

    // A run that has begun is reading the very files this would move under it —
    // the same reason a Fastfile write is refused while one is in flight.
    if (ctx.runs.hasActiveRun(slug)) {
      return reply.code(409).send({
        error: "A run of this project is in flight. Its workspace is in use until it finishes.",
      });
    }

    const branch = entry.default_branch;
    const workspace = new Workspace(ctx.workspacePath(slug), entry.git_url, entry.git_auth);

    // Refused rather than lost. `prepare` moves the branch onto origin's, and
    // the Fastfile tab commits without pushing by design, so this is a state the
    // product hands people itself.
    const unpushed = await workspace.unpushedCount(branch);
    if (unpushed > 0) {
      return reply.code(409).send({
        error:
          `The workspace holds ${unpushed} commit${unpushed === 1 ? "" : "s"} that ${
            unpushed === 1 ? "has" : "have"
          } not been pushed. ` + "Push from the fastfile tab, or they would be left behind.",
      });
    }

    try {
      const commitSha = await workspace.prepare(branch);
      return { branch, commitSha };
    } catch (cause) {
      // A dirty workspace, an unreachable remote, a branch that is not there:
      // git's own sentence is the only thing that explains any of them.
      return reply.code(409).send({ error: (cause as Error).message });
    }
  });

  /**
   * The number the next run of this project will be handed.
   *
   * Readable by anyone who may reach the project: it is what the next build
   * will carry, and a builder starting that build benefits from seeing it.
   */
  app.get("/api/projects/:slug/build-number", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return { next: ctx.buildNumbers.next(slug) };
  });

  /**
   * Sets where the counter carries on from. Admin only — see `permissions.ts`.
   *
   * The one part of the build number that has to be reachable: a project
   * arriving with a counter its repository already kept starts where that one
   * stopped, and an upload made by hand outside Laneyard is corrected here
   * rather than by editing a database.
   *
   * Refused while a run of this project is in flight. That run has already been
   * handed its number, so a write now would not reach it — it would silently
   * change what the *next* one gets, from a screen showing a build in progress.
   * The same reason the Fastfile write and the fetch are refused there.
   */
  app.put("/api/projects/:slug/build-number", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    const { next } = (req.body ?? {}) as { next?: unknown };
    if (typeof next !== "number" || !Number.isInteger(next) || next < 1) {
      return reply.code(400).send({ error: "A whole number, 1 or more." });
    }

    if (ctx.runs.hasActiveRun(slug)) {
      return reply.code(409).send({
        error: "A run of this project is in flight; it already holds its number. Wait for it to finish.",
      });
    }

    ctx.buildNumbers.set(slug, next);
    return { next };
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

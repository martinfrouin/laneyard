import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { FastfileStore } from "../../fastfile/store.js";
import type { VerifyResult } from "../../fastfile/store.js";
import { Workspace } from "../../git/workspace.js";
import type { AppContext } from "../app.js";

/** What every route here needs once the project is known to exist and its clone is present. */
interface Ready {
  workspacePath: string;
  fastlaneDir: string;
  workspace: Workspace;
  defaultBranch: string;
}

export async function registerFastfileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Stateless: the previous content it keeps in memory during a write lives
  // on the call stack, not on the instance, so sharing one across requests
  // costs nothing and mirrors how the other routes reuse a single `Workspace`.
  const store = new FastfileStore();

  /**
   * Common preamble: the project must exist and its clone must be present —
   * the Fastfile, like the lane list, lives in the repository. Sends the
   * response itself and returns null on failure so callers can bail out with
   * a single early return.
   */
  const ready = async (slug: string, reply: any): Promise<Ready | null> => {
    const entry = ctx.config.project(slug);
    if (!entry) {
      reply.code(404).send({ error: "Unknown project" });
      return null;
    }

    try {
      await ctx.ensureWorkspace(slug);
    } catch (cause) {
      reply.code(503).send({ error: (cause as Error).message });
      return null;
    }

    const workspacePath = ctx.workspacePath(slug);
    const resolved = await ctx.config.resolve(slug, workspacePath);
    return {
      workspacePath,
      fastlaneDir: resolved!.settings.fastlane_dir,
      workspace: new Workspace(workspacePath, entry.git_url, entry.git_auth),
      defaultBranch: entry.default_branch,
    };
  };

  app.get("/api/projects/:slug/fastfile", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const r = await ready(slug, reply);
    if (!r) return;

    try {
      const [content, dirty, diff] = await Promise.all([
        store.read(r.workspacePath, r.fastlaneDir),
        r.workspace.isDirty(),
        r.workspace.diff(join(r.fastlaneDir, "Fastfile")),
      ]);
      return { content, dirty, diff };
    } catch (cause) {
      // Unreadable Fastfile — deleted by hand, say — is the same kind of
      // "could not tell" as an unreadable lane list elsewhere in the API.
      return reply.code(503).send({ error: (cause as Error).message });
    }
  });

  app.put("/api/projects/:slug/fastfile", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { content } = (req.body ?? {}) as { content?: string };
    if (typeof content !== "string") {
      return reply.code(400).send({ error: "content is required" });
    }

    // The one refusal in this file, and not a heuristic: a run in flight is
    // reading the very file this write would replace, the same reason
    // `Workspace.prepare` refuses to touch a dirty workspace.
    if (ctx.runs.hasActiveRun(slug)) {
      return reply.code(409).send({
        error:
          "A run is in progress for this project. Wait for it to finish before editing the Fastfile.",
      });
    }

    const r = await ready(slug, reply);
    if (!r) return;

    // Asks the sidecar for the lanes: that parses the file and lists what it
    // found, which is exactly the two things that matter here — it still
    // parses, and the lanes are still there. The introspection cache is keyed
    // on a hash of the whole fastlane folder, so the changed content here is
    // what makes the next read of the lane list fresh — no separate
    // invalidation step needed.
    const verify = async (): Promise<VerifyResult> => {
      try {
        await ctx.lanes(slug, r.workspacePath, r.fastlaneDir);
        return { ok: true };
      } catch (cause) {
        return { ok: false, reason: (cause as Error).message };
      }
    };

    const result = await store.write(r.workspacePath, content, verify, r.fastlaneDir);
    if (!result.ok) return reply.code(400).send({ error: result.reason });
    return reply.code(204).send();
  });

  app.get("/api/projects/:slug/changes", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const r = await ready(slug, reply);
    if (!r) return;

    const [files, diff] = await Promise.all([r.workspace.status(), r.workspace.diff()]);
    return { files, diff };
  });

  app.post("/api/projects/:slug/commit", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { message } = (req.body ?? {}) as { message?: string };
    if (!message) return reply.code(400).send({ error: "A commit message is required" });

    const r = await ready(slug, reply);
    if (!r) return;

    // Exactly what changed, never `git add -A`: a build leaves files
    // scattered in the workspace, and this is the one place that must not
    // scoop them up because they happened to be there.
    const files = await r.workspace.status();
    if (files.length === 0) return reply.code(400).send({ error: "Nothing to commit" });

    await r.workspace.commit(message, files);
    return reply.code(204).send();
  });

  app.post("/api/projects/:slug/push", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const r = await ready(slug, reply);
    if (!r) return;

    try {
      await r.workspace.push(r.defaultBranch);
      return reply.code(204).send();
    } catch (cause) {
      return reply.code(400).send({ error: (cause as Error).message });
    }
  });
}

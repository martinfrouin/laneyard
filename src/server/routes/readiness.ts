import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { Workspace } from "../../git/workspace.js";
import { runChecks } from "../../heuristics/readiness.js";
import type { Known, LaneUses } from "../../heuristics/readiness.js";
import type { AppContext } from "../app.js";

const exec = promisify(execFile);

/**
 * `bundle check` in the workspace, rejecting with what bundler said.
 *
 * Installs nothing: the checklist reports, it does not act. The timeout is
 * generous because bundler resolves the whole Gemfile.lock, and short enough
 * that a wedged bundler does not hold the request open.
 */
async function bundleCheck(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("bundle", ["check"], { cwd, timeout: 60_000 });
    return stdout.trim();
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string; message: string };
    throw new Error((err.stdout || err.stderr || err.message).trim());
  }
}

/** The path of a `fastlane` a run would find, or null. */
async function findFastlane(): Promise<string | null> {
  try {
    const { stdout } = await exec("which", ["fastlane"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    // A non-zero exit from `which` is the answer "no", not a failure.
    return null;
  }
}

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

export async function registerReadinessRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * Computed only when asked for.
   *
   * These checks shell out to git and to bundler, so nothing else in the
   * interface may trigger them: the tab asks when it is opened, and when the
   * user presses refresh. Nothing here is cached either — a stale green tick is
   * worse than a red cross, which is why the answer carries the time it was
   * produced.
   */
  app.get("/api/projects/:slug/readiness", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });

    const workspacePath = ctx.workspacePath(slug);
    const workspace = new Workspace(workspacePath, entry.git_url, entry.git_auth);

    // What each lane calls lives in the repository, so the clone has to exist.
    // A clone that fails is not an error page: it is the reason two of the five
    // checks cannot answer, and the other three still can.
    let unreachable: string | null = null;
    try {
      await ctx.ensureWorkspace(slug);
    } catch (cause) {
      unreachable = (cause as Error).message;
    }

    const resolved = await ctx.config.resolve(slug, workspacePath);
    const fastlaneDir = resolved?.settings.fastlane_dir ?? "fastlane";

    const uses: Known<LaneUses[]> =
      unreachable !== null
        ? { ok: false, reason: unreachable }
        : await ctx
            .uses(slug, workspacePath, fastlaneDir)
            .then((lanes) => ({ ok: true as const, value: lanes }))
            // Broken Fastfile, no Ruby, no fastlane: all of them are "could not
            // tell", none of them is a 500.
            .catch((cause: unknown) => ({ ok: false as const, reason: (cause as Error).message }));

    const checks = await runChecks({
      probeRepository: () => workspace.probeRemote(),
      dependencies: {
        workspace:
          unreachable !== null
            ? { ok: false, reason: unreachable }
            : { ok: true, value: { hasGemfile: await exists(join(workspacePath, "Gemfile")) } },
        bundleCheck: () => bundleCheck(workspacePath),
        findFastlane,
      },
      // Names only: the vault never hands a value to anything but a run.
      secretKeys: ctx.vault.list(slug).map((s) => s.key),
      uses,
    });

    return { checkedAt: new Date().toISOString(), checks };
  });
}

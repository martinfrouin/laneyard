import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { MIN_LENGTH as MIN_REDACTABLE } from "../../logs/redact.js";
import { exportedVarNames } from "../../credentials/kinds.js";
import { requiredSecrets } from "../required-secrets.js";
import { dotenvLine } from "../../runner/env-file.js";

/** POSIX environment variable names. Anything else would never reach fastlane. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function registerSecretRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/projects/:slug/secrets", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return ctx.vault.listWithValues(slug);
  });

  const put = async (slug: string, key: string, body: unknown, reply: any) => {
    const { value, masked, inEnvFile } = (body ?? {}) as {
      value?: string;
      masked?: boolean;
      inEnvFile?: boolean;
    };
    if (!VALID_KEY.test(key)) {
      return reply.code(400).send({
        error: `"${key}" is not a valid environment variable name: letters, digits and underscore, not starting with a digit.`,
      });
    }
    if (typeof value !== "string" || value === "") {
      return reply.code(400).send({ error: "A value is required" });
    }
    // Accepting the tick box and quietly not honouring it would leave someone
    // believing they are protected. Refusing is the honest answer.
    if (masked !== false && value.length < MIN_REDACTABLE) {
      return reply.code(400).send({
        error:
          `A value kept out of the logs must be at least ${MIN_REDACTABLE} characters. ` +
          "Shorter than that, removing it would shred the log without hiding anything. " +
          "Store it unmasked if you accept it appearing in the output.",
      });
    }
    // Defaults to false: a variable goes in the file because someone said so,
    // never because a field was left out of a request.
    await ctx.vault.set(slug, key, value, masked !== false, inEnvFile === true);
    return reply.code(204).send();
  };

  app.put("/api/projects/:slug/secrets/:key", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return put(slug, key, req.body, reply);
  });

  /**
   * One value, in the clear — including a masked one, on request.
   *
   * A separate route rather than a field on the listing, and that is the whole
   * of what keeps a secret a secret here: reading one is a deliberate request
   * for one named key, by an admin, one at a time. The listing carries the
   * unmasked values and never a masked one, so opening the tab reveals nothing
   * — pressing `show` on a line does.
   *
   * It used to refuse a masked value outright, and `vault.ts` says at length why
   * that was worth less than it looked. The short version: `masked` is about
   * what a run prints, and refusing to ever show it again meant a passphrase
   * suspected of a typo could be replaced but never checked.
   */
  app.get("/api/projects/:slug/secrets/:key/value", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    const value = ctx.vault.reveal(slug, key);
    if (value === null) return reply.code(404).send({ error: "Unknown secret" });
    return { key, value };
  });

  /**
   * Turns a flag on or off, leaving the value alone.
   *
   * Needed because of a circle: to read a value you must first declare it not
   * secret, and declaring that by storing it again would mean typing the value
   * you were trying to read.
   *
   * Two independent flags, and either may be sent alone: `masked` is about what
   * a run prints, `inEnvFile` about whether the variable is also written into
   * the file the build reads. Sending one must not disturb the other — they
   * answer different questions about the same row.
   */
  app.patch("/api/projects/:slug/secrets/:key", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    const { masked, inEnvFile } = (req.body ?? {}) as { masked?: unknown; inEnvFile?: unknown };
    if (masked !== undefined && typeof masked !== "boolean") {
      return reply.code(400).send({ error: "`masked` is true or false." });
    }
    if (inEnvFile !== undefined && typeof inEnvFile !== "boolean") {
      return reply.code(400).send({ error: "`inEnvFile` is true or false." });
    }
    if (masked === undefined && inEnvFile === undefined) {
      return reply.code(400).send({ error: "Send `masked`, `inEnvFile`, or both." });
    }

    const existing = ctx.vault.list(slug).find((s) => s.key === key);
    if (!existing) return reply.code(404).send({ error: "Unknown secret" });

    // A value too short to redact cannot be masked, the same refusal as on the
    // way in — accepting it would leave someone believing they are protected.
    if (masked === true) {
      const value = ctx.vault.reveal(slug, key);
      if (value !== null && value.length < MIN_REDACTABLE) {
        return reply.code(400).send({
          error: `A value kept out of the logs must be at least ${MIN_REDACTABLE} characters.`,
        });
      }
    }

    if (masked !== undefined) ctx.vault.setMasked(slug, key, masked);
    if (inEnvFile !== undefined) ctx.vault.setInEnvFile(slug, key, inEnvFile);
    return reply.code(204).send();
  });

  /**
   * The environment file this project will write, before it writes it.
   *
   * The whole reason the flag lives on the variable rather than in a picker: a
   * list of tick boxes cannot tell you that one is missing, and this can. What
   * comes back is the file, rendered exactly as the run will render it, with
   * every masked value replaced by dots.
   *
   * **The masking happens before the render, never after.** Rendering the real
   * values and then trying to blank them would put every secret this project
   * holds into a browser and hope the second pass caught them all. The values
   * that leave this process are dots and the names beside them.
   */
  app.get("/api/projects/:slug/env-file", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    const resolved = await ctx.config.resolve(slug, ctx.workspacePath(slug));
    const path = resolved?.settings.env_file ?? null;
    const provenance = path === null ? null : (resolved?.provenance.env_file ?? null);

    const masked = new Set(
      ctx.vault
        .list(slug)
        .filter((s) => s.masked)
        .map((s) => s.key),
    );
    const values = ctx.vault.envFileValues(slug);
    const body = Object.keys(values)
      .sort()
      .map((key) => (masked.has(key) ? `${key}=••••\n` : dotenvLine(key, values[key]!)))
      .join("");

    return { path, provenance, body };
  });

  /**
   * The names this project needs, and which of them are still missing.
   *
   * Exists so the secrets screen can put the form up with the names already in
   * it. Someone arriving here has just been told by the checklist that eight
   * variables are missing; retyping those eight names by hand, correctly, is a
   * chore where one typo stores a secret nothing will ever read.
   *
   * Names only, and never a value from anywhere: the file that holds the real
   * ones is the file that does not reach a clone, which is the problem rather
   * than a source. What goes in the boxes is typed by a person.
   */
  app.get("/api/projects/:slug/required-secrets", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    const workspacePath = ctx.workspacePath(slug);
    const resolved = await ctx.config.resolve(slug, workspacePath);
    const fastlaneDir = resolved?.settings.fastlane_dir ?? "fastlane";

    // A workspace that was never cloned, or a Fastfile that will not parse, is
    // a reason to offer nothing — not a reason to fail the page someone opened
    // to store a secret by hand.
    const lanes = await ctx
      .uses(slug, workspacePath, fastlaneDir)
      .then((u) => u.lanes)
      .catch(() => []);

    return requiredSecrets({
      lanes,
      declared: resolved?.settings.required_secrets ?? [],
      workspacePath,
      fastlaneDir,
      vaultKeys: ctx.vault.list(slug).map((s) => s.key),
      blockNames: exportedVarNames(ctx.vault.listCredentials(slug)),
      serverEnv: Object.keys(process.env),
    });
  });

  app.delete("/api/projects/:slug/secrets/:key", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    const removed = ctx.vault.remove(slug, key);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Unknown secret" });
  });
}

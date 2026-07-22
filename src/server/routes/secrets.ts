import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { MIN_LENGTH as MIN_REDACTABLE } from "../../logs/redact.js";
import { requiredSecrets } from "../required-secrets.js";

/** POSIX environment variable names. Anything else would never reach fastlane. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function registerSecretRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const listRoute = (slug: string | null) =>
    slug === null ? ctx.vault.listGlobal() : ctx.vault.list(slug);

  app.get("/api/secrets", async () => listRoute(null));

  app.get("/api/projects/:slug/secrets", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return listRoute(slug);
  });

  const put = async (slug: string | null, key: string, body: unknown, reply: any) => {
    const { value, masked } = (body ?? {}) as { value?: string; masked?: boolean };
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
    await ctx.vault.set(slug, key, value, masked !== false);
    return reply.code(204).send();
  };

  app.put("/api/secrets/:key", async (req, reply) =>
    put(null, (req.params as { key: string }).key, req.body, reply),
  );

  app.put("/api/projects/:slug/secrets/:key", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return put(slug, key, req.body, reply);
  });

  /**
   * One value, in the clear — and only one that was never declared secret.
   *
   * A separate route rather than a field on the listing, so that reading a value
   * is always a deliberate request for one named key. A listing that carried
   * values would put every one of them in a browser at once, for a page most
   * people open to check a name.
   */
  app.get("/api/projects/:slug/secrets/:key/value", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    try {
      const value = ctx.vault.reveal(slug, key);
      if (value === null) return reply.code(404).send({ error: "Unknown secret" });
      return { key, value };
    } catch (cause) {
      // The vault refuses a masked value whoever asks. 409 rather than 403: the
      // request is not forbidden to this account, it is refused for this secret.
      return reply.code(409).send({ error: (cause as Error).message });
    }
  });

  /**
   * Turns the redaction on or off, leaving the value alone.
   *
   * Needed because of a circle: to read a value you must first declare it not
   * secret, and declaring that by storing it again would mean typing the value
   * you were trying to read.
   */
  app.patch("/api/projects/:slug/secrets/:key", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    const { masked } = (req.body ?? {}) as { masked?: unknown };
    if (typeof masked !== "boolean") {
      return reply.code(400).send({ error: "`masked` is true or false." });
    }

    const existing = ctx.vault.list(slug).find((s) => s.key === key);
    if (!existing) return reply.code(404).send({ error: "Unknown secret" });
    if (existing.scope === "global") {
      // The same rule the interface draws: a global secret belongs to every
      // project, so changing it from inside one would hide that from the rest.
      return reply.code(409).send({ error: "That is a global secret. Change it with `laneyard secret set`." });
    }

    // A value too short to redact cannot be masked, the same refusal as on the
    // way in — accepting it would leave someone believing they are protected.
    if (masked) {
      const value = ctx.vault.reveal(slug, key);
      if (value !== null && value.length < MIN_REDACTABLE) {
        return reply.code(400).send({
          error: `A value kept out of the logs must be at least ${MIN_REDACTABLE} characters.`,
        });
      }
    }

    ctx.vault.setMasked(slug, key, masked);
    return reply.code(204).send();
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
      serverEnv: Object.keys(process.env),
    });
  });

  app.delete("/api/secrets/:key", async (req, reply) => {
    const removed = ctx.vault.remove(null, (req.params as { key: string }).key);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Unknown secret" });
  });

  app.delete("/api/projects/:slug/secrets/:key", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    const removed = ctx.vault.remove(slug, key);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Unknown secret" });
  });
}

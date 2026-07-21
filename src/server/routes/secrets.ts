import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { MIN_LENGTH as MIN_REDACTABLE } from "../../logs/redact.js";

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

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import {
  MIN_PASSWORD_LENGTH,
  VALID_NAME,
  refusalFor,
  removeUserFromConfig,
  upsertUserInConfig,
} from "../../config/accounts.js";
import type { UserRole } from "../../config/schema.js";

const ROLES: UserRole[] = ["admin", "builder"];

/**
 * The accounts, as the interface sees them.
 *
 * Every route here is on the admin list in `permissions.ts`, so nothing below
 * checks a role: the hook already refused anyone who has no business here, and
 * a second check inside a handler is a permission nobody finds during an audit.
 */
export async function registerUserRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const accounts = () => ctx.config.server()?.users ?? [];

  // Name and role, and that is the whole shape. The hash is not truncated or
  // masked on the way out — it is simply never put on the wire.
  app.get("/api/users", async () => accounts().map((u) => ({ name: u.name, role: u.role })));

  app.post("/api/users", async (req, reply) => {
    const { name, role, password } = (req.body ?? {}) as {
      name?: unknown;
      role?: unknown;
      password?: unknown;
    };

    if (typeof name !== "string" || !VALID_NAME.test(name)) {
      return reply.code(400).send({
        error: "A name is letters, digits, dot, dash and underscore, starting with a letter or a digit.",
      });
    }
    if (typeof role !== "string" || !ROLES.includes(role as UserRole)) {
      return reply.code(400).send({ error: `A role is ${ROLES.join(" or ")}.` });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return reply
        .code(400)
        .send({ error: `A password is at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    const refusal = refusalFor(accounts(), name, role as UserRole);
    if (refusal) return reply.code(409).send({ error: refusal });

    const { created } = await upsertUserInConfig(ctx.config.configPath(), {
      name,
      role: role as UserRole,
      password,
    });

    // Replacing an account changes the password and possibly the role, and a
    // session holds neither — it holds a snapshot taken at login. The sessions
    // go, so that what was just written is what is true everywhere.
    if (!created) ctx.sessions.revokeAllFor(name);

    // The file is watched, but on a debounce: reloading here is what makes the
    // very next request — the listing this page is about to ask for — truthful,
    // and what lets the new account log in immediately.
    await ctx.config.load();

    return reply.code(created ? 201 : 200).send({ name, role });
  });

  app.delete("/api/users/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!accounts().some((u) => u.name === name)) {
      return reply.code(404).send({ error: "Unknown account" });
    }

    const refusal = refusalFor(accounts(), name, null);
    if (refusal) return reply.code(409).send({ error: refusal });

    const removed = await removeUserFromConfig(ctx.config.configPath(), name);
    if (!removed) return reply.code(404).send({ error: "Unknown account" });

    ctx.sessions.revokeAllFor(name);
    await ctx.config.load();

    return reply.code(204).send();
  });
}

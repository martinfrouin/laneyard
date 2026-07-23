import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import {
  MIN_PASSWORD_LENGTH,
  VALID_NAME,
  refusalFor,
  removeUserFromConfig,
  setUserProjectsInConfig,
  upsertUserInConfig,
} from "../../config/accounts.js";
import type { UserRole } from "../../config/schema.js";

/** The same slug rule the schema enforces, stated once for the grant route. */
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

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

  // Name, role, and the project grants — never the hash, which is simply never
  // put on the wire. `projects` is sent as it stands: an array when the account
  // carries a grant list, `null` when it has no field at all (every project),
  // the same three-way the storage keeps. The accounts screen ticks a checkbox
  // from it; an admin's is `null` and its checklist is not drawn.
  app.get("/api/users", async () =>
    accounts().map((u) => ({ name: u.name, role: u.role, projects: u.projects ?? null })),
  );

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

  /**
   * Sets which projects an account may reach.
   *
   * Admin-only, like every route in this file: it is covered by the
   * `/api/users` prefix in `REQUIRES_ADMIN`, so nothing here checks a role. The
   * list is written through the YAML document and takes effect on the next
   * request, since the auth hook re-reads config.yml every time — no session is
   * revoked, because the role has not changed, only what it reaches.
   *
   * An admin has no reach to restrict: the field is ignored for them, so writing
   * one would be a lie the server does not tell. The request is refused rather
   * than quietly written and forgotten.
   */
  app.put("/api/users/:name/projects", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { projects } = (req.body ?? {}) as { projects?: unknown };

    if (
      !Array.isArray(projects) ||
      !projects.every((p) => typeof p === "string" && VALID_SLUG.test(p))
    ) {
      return reply
        .code(400)
        .send({ error: "Projects is a list of slugs: lowercase letters, digits and hyphens." });
    }

    const account = accounts().find((u) => u.name === name);
    if (!account) return reply.code(404).send({ error: "Unknown account" });
    if (account.role === "admin") {
      return reply
        .code(400)
        .send({ error: "An admin reaches every project; there is no access list to set." });
    }

    const written = await setUserProjectsInConfig(ctx.config.configPath(), name, projects as string[]);
    if (!written) return reply.code(404).send({ error: "Unknown account" });

    // The file is watched on a debounce; reloading here makes the very next
    // request — and the reach check in the hook — see the grant at once.
    await ctx.config.load();

    return reply.code(200).send({ name, projects });
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

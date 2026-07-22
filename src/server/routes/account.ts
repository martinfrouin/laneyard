import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { MIN_PASSWORD_LENGTH, upsertUserInConfig } from "../../config/accounts.js";
import { COOKIE_OPTIONS, SESSION_COOKIE, authenticate } from "../auth.js";

/**
 * What someone may do to their own account, whatever their role.
 *
 * Deliberately not under `/api/users`: that prefix is on the admin list in
 * `permissions.ts`, and it means "the accounts on this machine". This is the
 * other thing entirely — one person, their own password — and a builder must be
 * able to reach it. Changing the password of somebody *else* stays admin-only,
 * and stays over there.
 *
 * The current password is required even though the session already proves who
 * this is. A session is a cookie in a browser that may have been left open on a
 * desk; a password is the one thing that says the person at the keyboard is
 * still the person who signed in.
 */
export async function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/api/account/password", async (req, reply) => {
    // Non-null: the hook in `app.ts` rejected every request without a session
    // before this handler could run.
    const { name, role } = req.identity!;
    const { current, next } = (req.body ?? {}) as { current?: unknown; next?: unknown };

    if (typeof next !== "string" || next.length < MIN_PASSWORD_LENGTH) {
      return reply
        .code(400)
        .send({ error: `A password is at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    const users = ctx.config.server()?.users ?? [];
    if (typeof current !== "string" || !(await authenticate(users, name, current))) {
      // No throttle here, unlike `/api/login`: reaching this route already costs
      // a valid session, so there is nobody to slow down who is not already in.
      return reply.code(401).send({ error: "That is not your current password." });
    }

    if (next === current) {
      return reply.code(400).send({ error: "That is the password you already have." });
    }

    // The role is carried over rather than read from the body: this route
    // changes a password and nothing else, and an account that could hand
    // itself `admin` in a field named `role` would make the whole permission
    // table decorative.
    await upsertUserInConfig(ctx.config.configPath(), { name, role, password: next });

    // Every session this account has, gone — including this one. That is the
    // point: changing a password is what someone does when they think another
    // browser somewhere should stop being signed in. A fresh session is issued
    // immediately afterwards, so the person who just did it is not signed out
    // of the page they did it on.
    ctx.sessions.revokeAllFor(name);
    const token = ctx.sessions.issue({ name, role });

    // The file is watched on a debounce; loading here is what makes the very
    // next request see the new hash instead of the old one.
    await ctx.config.load();

    return reply
      .setCookie(SESSION_COOKIE, token, COOKIE_OPTIONS)
      .code(204)
      .send();
  });
}

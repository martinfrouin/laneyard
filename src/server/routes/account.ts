import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { MIN_PASSWORD_LENGTH, VALID_NAME, renameUserInConfig, upsertUserInConfig } from "../../config/accounts.js";
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

  /**
   * Changing your own name — the other thing only you can do for yourself.
   *
   * Everything the password route is careful about is careful here for the same
   * reasons: the current password is asked for because a session is a cookie in
   * a browser that may have been left open; the role comes from the session and
   * never from the body, so a rename cannot smuggle in a promotion; and the
   * account this touches is only ever the session's own, there being no name in
   * the body to point anywhere else.
   *
   * The one thing that is not like the password route is the write. A rename is
   * not `upsertUserInConfig`, which keys by name and would add a second account
   * under the new name and leave the old one — and its `projects` grants —
   * behind. `renameUserInConfig` edits the `name` field of the existing entry in
   * place, so role, hash and grants ride along untouched.
   */
  app.post("/api/account/name", async (req, reply) => {
    const { name, role } = req.identity!;
    const { current, next } = (req.body ?? {}) as { current?: unknown; next?: unknown };

    if (typeof next !== "string" || !VALID_NAME.test(next)) {
      return reply.code(400).send({
        error: "A name is letters, digits, dot, dash and underscore, starting with a letter or a digit.",
      });
    }

    const users = ctx.config.server()?.users ?? [];
    if (typeof current !== "string" || !(await authenticate(users, name, current))) {
      // No throttle, for the same reason as the password route: reaching here
      // already costs a valid session.
      return reply.code(401).send({ error: "That is not your current password." });
    }

    if (next === name) {
      return reply.code(400).send({ error: "That is the name you already have." });
    }

    // A collision is refused rather than allowed to collapse two accounts into
    // one. The comparison is case-sensitive, because the stored names are: `Ci`
    // and `ci` are two accounts, and a rename to either is a rename to that one.
    if (users.some((u) => u.name === next)) {
      return reply.code(409).send({ error: `${next} is already the name of another account.` });
    }

    await renameUserInConfig(ctx.config.configPath(), name, next);

    // Every session under the old name goes — the auth hook matches a session's
    // name against a live account, and after this there is no account by that
    // name for it to match. A fresh session under the new name is issued at once,
    // so the person who just did it stays signed in on this page.
    ctx.sessions.revokeAllFor(name);
    const token = ctx.sessions.issue({ name: next, role });

    // The file is watched on a debounce; loading here is what makes the very next
    // request see the account under its new name rather than its old one.
    await ctx.config.load();

    // The new name is returned so the interface can update the header and this
    // page, now that the cookie it carries belongs to a different name.
    return reply
      .setCookie(SESSION_COOKIE, token, COOKIE_OPTIONS)
      .send({ name: next, role });
  });
}

/**
 * Who can do what — the whole answer, in one file.
 *
 * A permission expressed as an `if` inside a handler is a permission nobody
 * finds when it matters: during an audit, or after an incident. So there are no
 * such `if`s. Every route that needs more than a session is named below, and the
 * single hook in `app.ts` is the only thing that reads this.
 *
 * Two roles, and only two. `admin` may do everything; `builder` may start a
 * build, watch it, cancel it and download what it produced — nothing that
 * changes what a build does, and nothing that reveals a credential.
 */

import type { UserEntry } from "../config/schema.js";

/** A method and a path, where `*` means "whatever the verb". */
export interface RoutePattern {
  method: string;
  path: string;
}

/**
 * What each route needs. Everything absent from this list needs only a session.
 *
 * Reading the Fastfile is deliberately not here: a builder who can start a lane
 * benefits from seeing what it does, and it contains no credential — anything
 * that does is in the vault, which is.
 */
export const REQUIRES_ADMIN: RoutePattern[] = [
  { method: "*", path: "/api/secrets" },
  { method: "*", path: "/api/projects/:slug/secrets" },
  { method: "*", path: "/api/credentials" },
  { method: "*", path: "/api/projects/:slug/credentials" },
  { method: "PUT", path: "/api/projects/:slug/fastfile" },
  // Reading it is not restricted: it is what the next build will carry, and a
  // builder starting that build benefits from seeing it. Setting it changes
  // what a build produces, which is the line a builder does not cross.
  { method: "PUT", path: "/api/projects/:slug/build-number" },
  { method: "POST", path: "/api/projects/:slug/commit" },
  { method: "POST", path: "/api/projects/:slug/push" },
  { method: "DELETE", path: "/api/projects/:slug" },
  { method: "*", path: "/api/users" },
];

/**
 * `/api/secrets/APP_KEY?x=1` → `["api", "secrets", "APP_KEY"]`.
 *
 * Each segment is percent-decoded, because the router decodes before it matches
 * and this must see the same path the router did. Comparing the raw text sent
 * `GET /api/%73ecrets` straight past the admin list and into the vault: Fastify
 * routed it to `/api/secrets`, and this function had been looking at `%73ecrets`.
 */
function segments(url: string): string[] {
  return (url.split("?")[0] ?? "")
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        // Malformed escapes reach no route either; left as-is rather than
        // swallowed, so a segment is never silently emptied into a match.
        return s;
      }
    });
}

/**
 * Does this request need an admin?
 *
 * A pattern matches a request whose path *starts with* it, segment by segment,
 * with `:name` standing for any one segment. The prefix is deliberate:
 * `/api/secrets` means the vault, not one URL, and a table naming every key's
 * route separately would be a table someone forgets to extend the next time a
 * route is added under it. It only ever errs towards refusing, since every
 * entry here is a restriction.
 */
export function requiresAdmin(method: string, url: string): boolean {
  const parts = segments(url);
  const verb = method.toUpperCase();

  return REQUIRES_ADMIN.some((pattern) => {
    if (pattern.method !== "*" && pattern.method.toUpperCase() !== verb) return false;

    const expected = segments(pattern.path);
    if (parts.length < expected.length) return false;
    return expected.every((seg, i) => seg.startsWith(":") || seg === parts[i]);
  });
}

/**
 * May this account reach that project?
 *
 * The other half of the auth answer, and data-driven rather than a role: it is
 * still two roles, with the builder's reach narrowed by a list. An `admin`
 * reaches everything — managing the server is the whole role. A `builder` with
 * no `projects` field reaches everything too (an old config, untouched by this
 * feature); an empty list reaches nothing; a list reaches its slugs.
 *
 * Named and beside `REQUIRES_ADMIN` on purpose: the reach check is a permission,
 * and a permission expressed as an `if` inside a handler is one nobody finds
 * during an audit.
 */
export function accountMayReach(
  account: Pick<UserEntry, "role" | "projects">,
  slug: string,
): boolean {
  if (account.role === "admin") return true;
  if (account.projects === undefined) return true;
  return account.projects.includes(slug);
}

/**
 * The project a request concerns, or null when it concerns none.
 *
 * Two shapes carry a project:
 *
 *   `/api/projects/:slug/*` — the slug is in the path. The bare `/api/projects`
 *     listing carries none: it is filtered in its own handler, per account.
 *   `/api/runs/:id/*` — a run addresses a project by id, not a slug, so the id
 *     is mapped through `runSlug`. An id that names no run yields null, and the
 *     handler answers its own 404 for the unknown run.
 *
 * Everything else — the vault, the accounts, `/api/me` — concerns no single
 * project and returns null, passing the reach check untouched.
 *
 * `runSlug` is handed in rather than the run store reached into, so the mapping
 * this depends on stays a one-line lookup the caller owns and this stays a pure,
 * testable function.
 */
export function projectSlugOfRequest(
  url: string,
  runSlug: (runId: number) => string | null,
): string | null {
  const parts = segments(url);
  if (parts[0] !== "api") return null;

  if (parts[1] === "projects" && parts.length >= 3) return parts[2] ?? null;

  if (parts[1] === "runs" && parts.length >= 3) {
    const id = Number(parts[2]);
    return Number.isInteger(id) ? runSlug(id) : null;
  }

  return null;
}

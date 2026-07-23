# Per-project access

Date: 2026-07-23
Status: approved, not implemented

## The problem

Access is a single global role. A `builder` (`config/schema.ts`) sees every
project and can start any build; the only thing role withholds is credentials,
the Fastfile write, and account management. There is no way for an admin to say
"this person builds these projects and not those."

The author wants exactly that, and settled the shape in conversation:

- A builder sees **nothing by default**; an admin grants projects one at a time.
  An admin always sees everything (managing the server is their whole role).
- A project a builder cannot access is **invisible** — absent from their list,
  and unreachable by URL. Not shown-and-locked.
- The admin manages this **from the accounts screen**: each account carries the
  list of projects it may reach.
- Deleting a project **removes it from every account's list**.

## Storage: a field on the account, in `config.yml`

The product's rule is that configuration lives in files and the database holds
only execution state. Who may reach what is configuration, so it lives in
`config.yml`, on the user entry, beside `role`:

```yaml
users:
  - { name: lea, role: builder, projects: [cartes-ios] }
```

`userEntrySchema` gains `projects?: string[]`, with a deliberate three-way
meaning that carries back-compat for free:

- **absent** → all projects. A `config.yml` written before this feature has no
  `projects` field on anyone, so nobody loses access on upgrade.
- **`[]`** (empty) → no projects. This is what account creation now writes, so a
  *new* account starts with nothing until granted.
- **a list** → those slugs.

The distinction rides on absent-vs-empty, which YAML represents faithfully, so
no migration pass or marker is needed. An `admin` ignores the field entirely.

## Enforcement: one place, server-side

The invisibility must be real, not a hidden UI. It goes in the one auth hook
(`server/app.ts` `onRequest`, ~line 239) that already looks the account up fresh
from `config.yml` on every request and enforces `REQUIRES_ADMIN` — the codebase's
stated principle that "a permission expressed as an `if` inside a handler is one
nobody finds during an audit."

After `identity` is resolved, and only for a non-admin:

- Determine the **project slug the request concerns**:
  - `/api/projects/:slug/*` — the slug is in the path.
  - run-scoped API routes (the run view, its log stream, its artifacts) address a
    run by id, not a slug; map id → `project_slug` via `ctx.runs`
    (`run.projectSlug` exists on the record). One small lookup, in the hook, so
    the rule stays in one place rather than sprinkled through run handlers.
- If the account's `projects` does not include that slug, answer **404 with the
  same body a genuinely unknown project gives** (`{ error: "Unknown project" }`).
  A 403 would confirm the project exists; 404 keeps it invisible.

`absent = all` is checked here too: an account with no `projects` field passes
every slug.

Write a `projectSlugOfRequest(req, ctx)` helper returning the concerned slug or
null, and an `accountMayReach(account, slug)` predicate. The hook is where they
are used; keeping them named and testable is what lets the audit be a read.

## The project list is filtered

`GET /api/projects` (`server/routes/projects.ts:7`) returns only the slugs the
requesting account may reach — `req.identity` is set by the hook. This is the
source of the invisibility the interface shows: the nav and the project list are
already driven by this endpoint, so a filtered response filters the UI with no
web change beyond what the data already carries.

## Granting, from the accounts screen

The accounts screen (`web/src/pages/Users.tsx`) gains, per account, the list of
projects with a checkbox each — the account's current grants ticked. An admin
ticks and unticks; saving writes the `projects` list to that user's entry in
`config.yml`.

A new route, admin-only, carries the change: `PUT /api/users/:name/projects`
(covered already by `{ method: "*", path: "/api/users" }` in `REQUIRES_ADMIN` —
confirm the prefix match, and add a test since inheritance is what breaks when
the list is reordered). It writes through the YAML document, the way
`config/accounts.ts` already edits users, so a hand-written file keeps its shape.

An `admin` account shows no checklist: it reaches everything, and offering to
restrict it would be a lie the server would ignore.

## Account creation writes `[]`

Both paths that create an account write `projects: []` explicitly, so a new
account starts with no access rather than falling into `absent = all`:

- `POST /api/users` (`server/routes/users.ts`),
- `laneyard user add` (`cli/user.ts`).

An admin created this way is unaffected (the field is ignored for admins), but
writing it keeps the two roles' entries uniform.

## Deleting a project cleans up

The delete route (`server/routes/projects.ts`, ~line 39) already edits
`config.yml` as a YAML document to drop the project block. It also strips the
slug from every account's `projects` list in the same edit. A grant pointing at a
project that no longer exists is dead data, and — the same hazard as the vault —
a project re-created later with that slug must not silently inherit an old grant.

## Back-compat and defaults, together

- Existing install, existing builders: no `projects` field → they keep seeing
  everything, exactly as before, until an admin chooses to restrict.
- New builder: created with `[]` → sees nothing until granted.
- Admin: always everything.

## Testing

- A builder with `projects: [a]` is served `a` and 404s on `b`, for every verb
  and every `/api/projects/b/*` route, and on `b`'s runs by run id.
- `GET /api/projects` returns only granted slugs for a builder, all for an admin.
- A builder with no `projects` field (old config) sees everything (back-compat).
- A builder with `projects: []` sees nothing.
- Granting via `PUT /api/users/:name/projects` writes `config.yml` and takes
  effect on the next request (the hook re-reads config each time).
- The grant route refuses a non-admin.
- Deleting a project removes its slug from every account's list.
- Account creation (route and CLI) writes `projects: []`.

## Notes

Written against a working tree with the 0.2 back-compat removal and the per-app
`laneyard.yml` work landing first; line references are to that tree. Touches
`config/schema.ts`, `config/accounts.ts`, `server/app.ts` (hook),
`server/permissions.ts` (a helper, or a note that the check is data-driven and
lives beside `REQUIRES_ADMIN`), `server/routes/projects.ts`,
`server/routes/users.ts`, `cli/user.ts`, `web/src/pages/Users.tsx`,
`web/src/api.ts` — and deliberately no per-route `if`.

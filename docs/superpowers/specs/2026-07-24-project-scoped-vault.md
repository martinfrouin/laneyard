# A vault scoped to one project

Date: 2026-07-24
Status: approved, not implemented

## The problem

The vault has two scopes. A secret or a signing block stored with no project
applies to every project; one stored under a slug wins over it. `Vault` carries
that everywhere — `projectSlug: string | null` on every write, `listGlobal` and
`listGlobalCredentials` beside `list`, `ownedBy` and `forget` documented around
the fact that a global row survives a project's removal.

It buys sharing and costs the answer to one question: *what exactly does this
project see?* Today that answer is a merge of two tables that no screen shows
whole. A secret named twice resolves silently to the nearer one, and an admin
editing a global from inside a project changes builds of projects they were not
looking at.

The author has settled it: **everything belongs to one project, signing blocks
included.** An App Store Connect key shared by five apps is uploaded five times,
and rotated five times. That cost is accepted, in exchange for a rule with no
exception to state.

## What changes

**One scope.** `projectSlug` stops being nullable throughout: `Vault.set`,
`remove`, `setMasked`, `setCredential`, `removeCredential`. `listGlobal` and
`listGlobalCredentials` go. `list` and `listOwn` become the same question, so
`ownedBy` collapses into `list`/`listCredentials` and `forget` loses the
paragraph about what survives it — nothing does.

**The schema keeps its shape.** `secret` and `credential` are already keyed on
`(project_slug, …)`; the empty-string default was there so a global row could
have a stable key. The column stays `NOT NULL`, the `DEFAULT ''` goes, and the
comment above `secret` explaining why global is `''` rather than `NULL` goes with
it.

**Rows already stored globally are copied, not dropped.** A global secret applied
to every project, so writing it into every project preserves exactly the
behaviour it had. Startup migration: for each row with an empty `project_slug`,
insert a copy under every configured slug that does not already define that key
or kind, then delete the original. A project that overrode a global keeps its own
value — the copy skips it, which is the same precedence, made permanent.

It runs once and reports what it did on stdout, per project and per key. Silence
would be wrong here: the user gets five copies of one key where they had one, and
must know so they can delete the four they do not want.

**The routes lose their global forms.** `routes/secrets.ts` and
`routes/credentials.ts` drop the scope parameter; every path is already
project-addressed. Permissions are unchanged — these screens are admin-only and
stay so.

**The interface loses its global section.** In `web/src/pages/Secrets.tsx`, the
`scope === "global"` branches go: the row that cannot be edited from inside a
project, and the badge that marked it. `CredentialCard.tsx` loses the same
distinction. The API type loses `scope`.

**The docs lose two sentences.** In `credentials.md`, "Global secrets apply
everywhere; a project's own win over them" and "A block on a project beats a
global one of the same kind". `readiness.md` is unaffected: it asks whether a
name is in the vault, and the vault a project sees is now simply its own.

## What this makes possible

The scope that remains is inside a project. A variable is global **to its
project**, or attached to a named lane — the two levels the author wants, with
nothing above them. That second level is not built here; it is the reason this
spec comes first, because a three-level precedence (global, project, lane) is a
rule nobody could hold in their head while reading a build log.

## Testing

- the migration copies a global to every project, skips a project that already
  defines the key, deletes the original, and is a no-op on second run;
- a project's secrets and blocks are gone after `forget`, and nothing is left in
  either table;
- the routes reject a request with no slug rather than falling back to anything.

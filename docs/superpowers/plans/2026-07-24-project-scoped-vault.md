# Project-scoped vault — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the cross-project scope from the vault, so every secret and every signing block belongs to exactly one project.

**Architecture:** The empty `project_slug` is the global scope's key. A startup migration copies each such row into every configured project that does not already define that key or kind, then deletes it — behaviour preserved, scope gone. `SecretStore` and `CredentialStore` then lose `applicable`'s two-table merge, `listGlobal`, and the `listOwn`/`list` distinction; `Vault` loses its nullable `projectSlug`; the routes lose their unscoped forms; the interface loses its global badge.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3, Fastify, React + Vite, Vitest.

Spec: `docs/superpowers/specs/2026-07-24-project-scoped-vault.md`

Run tests with `npm test -- <path>` and the whole suite with `npm test`. Typecheck both projects with `npm run typecheck`.

---

### Task 1: The migration

Copies global rows into every project, then deletes them. Written first so that no
later task can strand data behind an interface that no longer reads it.

**Files:**
- Create: `src/db/migrate-global-scope.ts`
- Test: `tests/db/migrate-global-scope.test.ts`

- [ ] **Step 1: Write the failing tests**

Open a database with `openDatabase` on a temp path (`tests/db/secrets.test.ts` shows
the pattern). Insert rows directly with SQL, call
`migrateGlobalScope(db, ["alpha", "beta"])`, assert on the tables afterwards.

Cases:
- a global secret with no project override lands under both slugs, and the
  `project_slug = ''` row is gone;
- a global secret that `alpha` already defines keeps `alpha`'s value, and still
  lands under `beta`;
- the same two cases for `credential`, keyed on `kind`;
- `masked`, `updated_at`, `var_names` and both ciphertext columns survive the copy
  unchanged;
- a second call is a no-op and reports nothing;
- with no projects configured, global rows are deleted and reported as dropped —
  there is nowhere to put them, and leaving them would leave rows no code reads;
- the report names each key and each project it was copied to.

- [ ] **Step 2: Run to verify they fail**

`npm test -- tests/db/migrate-global-scope.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`export interface GlobalScopeMigration { copied: { key: string; slugs: string[] }[]; dropped: string[] }`
and `export function migrateGlobalScope(db: Db, slugs: string[]): GlobalScopeMigration`.

One transaction. For `secret`, select `WHERE project_slug = ''`; for each row and
each slug, `INSERT … ON CONFLICT (project_slug, key) DO NOTHING` so an override
wins by doing nothing. Then `DELETE FROM secret WHERE project_slug = ''`. Same for
`credential` on `(project_slug, kind)`. Comment says why a conflict is skipped
rather than overwritten: it is the same precedence the merge had, made permanent.

- [ ] **Step 4: Run to verify they pass**

`npm test -- tests/db/migrate-global-scope.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate-global-scope.ts tests/db/migrate-global-scope.test.ts
git commit -m "Move what was everyone's into each project that read it"
```

---

### Task 2: Run the migration at startup, and say what it did

**Files:**
- Modify: `src/main.ts:59-70`
- Test: `tests/db/migrate-global-scope.test.ts` (extend)

- [ ] **Step 1: Wire it in**

Between `openDatabase(...)` and `Vault.open(...)`, call
`migrateGlobalScope(db, config.projects().map((p) => p.slug))`. Print one line per
copied key on stdout — `SENTRY_DSN copied to alpha, beta` — and one for anything
dropped. Silence would be wrong: the user gets five copies of a key they stored
once and must know, in order to delete the four they do not want.

- [ ] **Step 2: Typecheck and run the suite**

`npm run typecheck && npm test` → PASS

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "Say what became of a secret that belonged to everything"
```

---

### Task 3: `SecretStore` holds one scope

**Files:**
- Modify: `src/db/secrets.ts`
- Test: `tests/db/secrets.test.ts`

- [ ] **Step 1: Rewrite the tests for one scope**

Delete the cases covering global precedence and `listGlobal`. Keep and adjust:
`set` then `list`; `find` on a missing key; `setMasked` returning false for an
unknown row; `removeAllOwn` counting. Add: a row stored under `alpha` is invisible
to `beta` — the property the whole change exists to give.

- [ ] **Step 2: Run to verify they fail**

`npm test -- tests/db/secrets.test.ts` → FAIL

- [ ] **Step 3: Implement**

Drop `const GLOBAL`, the `Scope` type and `scope` from `SecretSummary`. `applicable`
becomes `SELECT * FROM secret WHERE project_slug = ? ORDER BY key` and folds into
`list`. Delete `listGlobal`. `listOwn` and `removeAllOwn` lose their empty-slug
guard; `listOwn` becomes an alias worth deleting — replace its call sites with
`list` in Task 5. Every `projectSlug: string | null` becomes `string` and every
`?? GLOBAL` goes. Update the class comment: the precedence paragraph describes
something that no longer exists.

- [ ] **Step 4: Run to verify they pass**

`npm test -- tests/db/secrets.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/secrets.ts tests/db/secrets.test.ts
git commit -m "A secret is one project's, and no one else can see it"
```

---

### Task 4: `CredentialStore` holds one scope

**Files:**
- Modify: `src/db/credentials.ts`
- Test: `tests/db/credentials.test.ts`

Same shape as Task 3, keyed on `kind`. `scope` leaves `CredentialSummary`,
`listGlobal` goes, `applicable` becomes a single-slug query, `listOwn` folds into
`list`.

- [ ] **Step 1: Rewrite the tests** — drop the shadowing cases, add the isolation one
- [ ] **Step 2: Run to verify they fail** — `npm test -- tests/db/credentials.test.ts`
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit**

```bash
git add src/db/credentials.ts tests/db/credentials.test.ts
git commit -m "A signing block is one project's too"
```

---

### Task 5: `Vault` loses the notion

**Files:**
- Modify: `src/secrets/vault.ts`
- Test: `tests/secrets/vault.test.ts`, `tests/secrets/vault-credentials.test.ts`

- [ ] **Step 1: Rewrite the tests**

Drop the global cases. Keep `resolve` skipping an unreadable row, `resolveCredential`
throwing on one, `maskedValues` including a block's secret fields, `reveal` returning
a masked value.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

Delete `listGlobal` and `listGlobalCredentials`. `ownedBy` and `forget` now ask the
same question as `list` — delete `ownedBy`, and let its caller use `list` and
`listCredentials`. Rewrite `forget`'s doc comment: the paragraph about what survives
it describes nothing now. Every `projectSlug: string | null` becomes `string`.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/secrets/vault.ts tests/secrets/
git commit -m "The vault answers for one project at a time"
```

---

### Task 6: The routes lose their unscoped forms

**Files:**
- Modify: `src/server/routes/secrets.ts`, `src/server/routes/credentials.ts`
- Test: `tests/server/secrets.test.ts`, `tests/server/credentials.test.ts`

- [ ] **Step 1: Rewrite the tests**

Assert that `GET /api/secrets`, `PUT /api/secrets/:key`, `DELETE /api/secrets/:key`
and the three `/api/credentials` equivalents answer 404. Drop the case asserting a
409 on a global secret's `PATCH`. Keep everything project-addressed.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

Delete the six unscoped routes and the `listRoute` helper — `listWithValues` is the
only listing now. In `PATCH`, delete the `existing.scope === "global"` branch and
the comment above it. In `credentials.ts`, rewrite the comment on the project
`DELETE`: it explains an override coming back into view, which cannot happen.
`put`'s `slug` parameter loses its `| null`.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/secrets.ts src/server/routes/credentials.ts tests/server/secrets.test.ts tests/server/credentials.test.ts
git commit -m "Every way in names a project"
```

---

### Task 7: Removing a project no longer leaves anything behind

**Files:**
- Modify: `src/server/routes/projects.ts:45-130`
- Test: `tests/server/remove-project.test.ts`

- [ ] **Step 1: Rewrite the tests** — the removal preview no longer reports `globalSecrets` or `globalSigningBlocks`
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement** — drop both counts and the paragraph explaining what is left alone; nothing is
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit**

```bash
git add src/server/routes/projects.ts tests/server/remove-project.test.ts
git commit -m "Removing a project leaves nothing of it"
```

---

### Task 8: The CLI stops counting what is gone

**Files:**
- Modify: `src/cli/uninstall.ts:40-60,170-200,290-360`, `src/cli/reset.ts:35-45`
- Test: `tests/cli/uninstall.test.ts`, `tests/cli/remove.test.ts`

- [ ] **Step 1: Rewrite the tests** — the summary counts secrets and blocks, without a global line
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement** — `globalSecrets`/`globalBlocks` leave the `Vault` summary type, the two `project_slug = ''` counts go, and the two "shared by every project" lines with them
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit**

```bash
git add src/cli/uninstall.ts src/cli/reset.ts tests/cli/
git commit -m "Nothing is shared, so nothing says it is"
```

---

### Task 9: The interface loses its global badge

**Files:**
- Modify: `web/src/api.ts:105-145`, `web/src/pages/Secrets.tsx:215-255`, `web/src/components/CredentialCard.tsx`, `web/src/pages/Settings.tsx`

- [ ] **Step 1: Implement**

`scope` leaves both API types, along with `globalSecrets`/`globalSigningBlocks` on
the removal summary. In `Secrets.tsx`, the `scope !== "global"` guard around the
row's controls goes — every row is editable — and the `global` badge with it. Same
in `CredentialCard.tsx`. In `Settings.tsx`, drop whatever surfaced the global
counts.

- [ ] **Step 2: Typecheck the web project**

`npm run typecheck` → PASS

- [ ] **Step 3: Commit**

```bash
git add web/src
git commit -m "One list, and every line of it belongs here"
```

---

### Task 10: Schema and documentation

**Files:**
- Modify: `src/db/schema.sql:53-63,76-78`, `docs/credentials.md`, `docs/managing.md`

- [ ] **Step 1: Implement**

Drop `DEFAULT ''` from `project_slug` in both tables and the comment above `secret`
explaining why global is `''` rather than `NULL`. In `credentials.md`, delete
"Global secrets apply everywhere; a project's own win over them" and "A block on a
project beats a global one of the same kind"; check `managing.md` for the same
claim. `readiness.md` needs nothing — it asks whether a name is in the vault, and
the vault a project sees is now simply its own.

- [ ] **Step 2: Run the whole suite and both typechecks**

`npm run typecheck && npm test` → PASS

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.sql docs/
git commit -m "Say it once: what a project holds is its own"
```

---

### Task 11: End to end

- [ ] **Step 1:** `npm run typecheck && npm test` → PASS
- [ ] **Step 2:** `grep -rn "listGlobal\|scope === \"global\"\|GLOBAL" src web/src` → no hits
- [ ] **Step 3:** Start a server against a home with a pre-migration database, confirm the copy report prints and the secrets screen shows the copies under each project

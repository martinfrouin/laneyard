# Environment file — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project's gitignored `.env` — the one its build reads as a file, not as an environment variable — exist for the length of a run.

**Architecture:** A secret gains one flag, *in the environment file*. A project gains one setting, `env_file`, resolved from `laneyard.yml` or the server block like every other setting. At run time the flagged secrets are rendered as dotenv and written to that path, marked, and removed when the run ends — the lifecycle `gradle-properties.ts` already established, reused rather than reinvented.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3, zod, Fastify, React + Vite, Vitest.

Spec: `docs/superpowers/specs/2026-07-24-environment-file.md`
Depends on: `docs/superpowers/plans/2026-07-24-project-scoped-vault.md` (done)

Run tests with `npm test -- <path>`, the whole suite with `npm test` (~130s), and both typechecks with `npm run typecheck`.

---

### Task 1: The flag on a secret

**Files:**
- Modify: `src/db/schema.sql`, `src/db/secrets.ts`, `src/db/open.ts`
- Test: `tests/db/secrets.test.ts`

- [ ] **Step 1: Write the failing tests**

- `set` takes `inEnvFile` and `list` returns it;
- it defaults to false for a row stored without it;
- `setInEnvFile(slug, key, true)` flips it, leaves the value alone, and returns
  false for an unknown row — the same shape as `setMasked`, and for the same
  reason: flipping a flag must not mean retyping a value you cannot read;
- `envFileKeys(slug)` returns the flagged keys, sorted, and nothing from another
  project.

Add to `tests/db/cache-migration.test.ts` (or a sibling): a database whose
`secret` table predates the column gains it, with every existing row at 0.

- [ ] **Step 2: Run to verify they fail**

`npm test -- tests/db/secrets.test.ts`

- [ ] **Step 3: Implement**

In `schema.sql`, `in_env_file INTEGER NOT NULL DEFAULT 0` on `secret`. `CREATE
TABLE IF NOT EXISTS` leaves an existing table alone, so `open.ts` needs an
`ALTER TABLE … ADD COLUMN` guarded by `PRAGMA table_info`, beside
`migrateIntrospectionCache` and following its shape. Not a drop: this table is
the vault, and the comment should say why the cache's answer is wrong here.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/db tests/db
git commit -m "Let a secret say it belongs in a file"
```

---

### Task 2: `env_file` as a setting

**Files:**
- Modify: `src/config/schema.ts:9-33`, `src/config/resolve.ts:36-45`
- Test: `tests/config/` (follow the existing resolve tests)

- [ ] **Step 1: Write the failing tests**

- `env_file` in `laneyard.yml` wins over the server block, and provenance says
  `repo` — the rule every other setting follows;
- an app-relative `env_file` in a monorepo file comes out repo-root-relative,
  like `fastlane_dir`;
- a value climbing out of the workspace (`../../.env`, an absolute path) is
  refused at load, and the previous configuration stays live.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

`env_file: z.string().optional()` on `projectSettingsSchema` — optional with no
default, so absent means off and there is no empty string to interpret. Add it to
the path fields in `normaliseAppConfig`. The escape check belongs in the schema
as a `.refine`, so an invalid value is reported by the same machinery that
reports every other one.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/config tests/config
git commit -m "Say where the file goes, in the file that says everything else"
```

---

### Task 3: Rendering dotenv

The one piece with no dependency on anything else. Pure function, tested alone.

**Files:**
- Create: `src/runner/env-file.ts`
- Test: `tests/runner/env-file.test.ts`

- [ ] **Step 1: Write the failing tests**

`renderDotenv({ B: "2", A: "1" })` → `A=1\nB=2\n`, sorted by name so a diff of two
runs is readable. Then the quoting, which is the whole risk in this function:

| value | written as |
| --- | --- |
| `plain` | `plain` |
| `has space` | `"has space"` |
| `has#hash` | `"has#hash"` |
| `has"quote` | `"has\"quote"` |
| `has\backslash` | `"has\\backslash"` |
| `line\nbreak` | `"line\nbreak"` (escaped, never literal) |
| `` (empty) | `` |

A newline written literally would silently truncate the value at the next
parser — the same failure `escapeValue` in `gradle-properties.ts` guards against,
and worth a comment saying so.

Round-trip the whole table through a dotenv parser in the test, so the assertion
is "a parser reads back what went in" rather than "the string looks right".

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement `renderDotenv`**

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/runner/env-file.ts tests/runner/env-file.test.ts
git commit -m "Write a value a parser reads back unchanged"
```

---

### Task 4: Writing, removing, sweeping

**Files:**
- Modify: `src/runner/env-file.ts`
- Test: `tests/runner/env-file.test.ts`

- [ ] **Step 1: Write the failing tests**

- with no `env_file`, nothing is written and null comes back;
- with one, the file is at `<appRoot>/<env_file>`, first line
  `# written by laneyard, do not commit`, mode `600`;
- a file already there **without** the marker is not written over, not removed,
  and null comes back — it is the user's;
- a file there **with** the marker is replaced;
- `removeEnvFile` deletes a marked file and leaves an unmarked one;
- `sweepEnvFile` removes a marked leftover before a run starts, and is silent
  about a workspace that was never cloned.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

`writeEnvFile`, `removeEnvFile`, `sweepEnvFile`, mirroring
`gradle-properties.ts` — reuse its `LANEYARD_MARKER` rather than declaring a
second one. Export `firstLine` from there, or lift it to a shared module if that
reads better than importing across two runner files.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/runner/env-file.ts tests/runner/env-file.test.ts
git commit -m "The file lives exactly as long as the run does"
```

---

### Task 5: Into the run

**Files:**
- Modify: `src/runner/orchestrate.ts:95-108,205-225`, `src/runner/queue.ts`
- Test: `tests/runner/env-file.test.ts` (an `executeRun` case, as `materialise.test.ts` has)

- [ ] **Step 1: Write the failing tests**

- a run writes the file before fastlane starts and it is gone afterwards;
- it is gone after a run that **failed**, and after one that was **cancelled** —
  the case a `finally` exists for;
- a flagged secret reaches the run as an environment variable **as well as** a
  line in the file. The flag decides membership of the file and nothing else, and
  a test is the only thing that will keep that true.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

The holder in `executeRun` becomes `{ properties, envFile }`; both are removed in
the `finally`. `sweepEnvFile` goes beside `sweepGradleProperties`, and
`writeEnvFile` beside `writeGradleProperties`, using the same `appRoot`.

A failure to write **fails the run**, like the properties file: a build that
carries on without the configuration it asked for produces an app pointed at
nothing, and finding that out from the store is worse than a run that stopped.

The queue passes the flagged secrets down — it already resolves the vault for the
environment, so this is a second use of the same read, not a second read.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/runner tests/runner
git commit -m "Put the file in the clone, for the length of one build"
```

---

### Task 6: The flag over HTTP

**Files:**
- Modify: `src/server/routes/secrets.ts`
- Test: `tests/server/secrets.test.ts`

- [ ] **Step 1: Write the failing tests**

- `PUT` accepts `inEnvFile` and the listing reports it;
- `PATCH` flips it alone, and flips `masked` alone, and one does not disturb the
  other;
- a new endpoint answers the preview: the path, where it came from, and the
  rendered body with masked values as `••••`. **Never a masked value in the
  clear** — that is the property the whole vault rests on, and a preview is
  exactly where it would be lost by accident.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/server tests/server
git commit -m "Ask for the file, and be shown what it will hold"
```

---

### Task 7: The screen

**Files:**
- Modify: `web/src/api.ts`, `web/src/pages/Secrets.tsx`

- [ ] **Step 1: Implement**

A checkbox per row — *in the environment file* — beside the `secret` one, and the
list grouped on it so the file's variables read together. Above them, the panel:
the path, the file it came from, and the body that will be written.

No panel at all when `env_file` is unset. An empty state is a thing to explain,
and there is nothing to explain to a project that does not want a file.

- [ ] **Step 2: Typecheck**

`npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add web/src
git commit -m "Show the file, so nothing has to be remembered"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/credentials.md`, `docs/configuration.md`, `CHANGELOG.md`

- [ ] **Step 1: Implement**

`configuration.md` gains `env_file` in the `laneyard.yml` block.
`credentials.md` gains a short section under Secrets: what it is for (a build
that reads a file, not a variable), the flag, the marker, and the fact that a
file of your own is never touched. The CHANGELOG entry goes **under 0.8.0**,
beside the vault section — the version stays where it is until the whole thing
is finished.

- [ ] **Step 2: Commit**

```bash
git add docs CHANGELOG.md
git commit -m "Say what the file is and where it comes from"
```

---

### Task 9: End to end

- [ ] **Step 1:** `npm run typecheck && npm test` → PASS
- [ ] **Step 2:** Against a real home: a project with `env_file: .env`, two flagged secrets, one run. The file exists during the build and is gone after it.
- [ ] **Step 3:** Put an unmarked `.env` in the clone by hand and run again. It is still there, byte for byte, afterwards.

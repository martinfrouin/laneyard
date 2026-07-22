# Signing Credential Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store an App Store Connect `.p8`, a Play service account JSON and an Android keystore as file-plus-fields blocks, materialise them at run time, and make a Flutter release build sign with the real key instead of the debug one.

**Architecture:** A new `credential` table holds one block per `(project_slug, kind)`; file bytes and fields are encrypted through the existing `cipher.ts`, and `Vault` remains the only component that decrypts. At run preparation each applicable block is written to a per-run directory outside the git clone, and its configured variable names are exported. The single exception is the Gradle properties file, which must live in the clone — it carries a marker comment so Laneyard can sweep it and so readiness never reads its own writing.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3, Fastify, React + Vite, vitest.

**Spec:** `docs/superpowers/specs/2026-07-22-credential-blocks-design.md`

---

## Before you start

Read the spec. It carries the reasoning behind decisions this plan only executes — in particular why the build script is never patched, and why the properties file needs a marker.

**The repository has substantial uncommitted work in progress** (43 modified files, 15 untracked). Do not commit files you did not change. Every commit in this plan names its files explicitly with `git add <paths>` — never `git add -A` or `git add .`.

Test command throughout: `npx vitest run <path>`. Full suite: `npm test`. Type check: `npm run typecheck`.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/db/credentials.ts` | `CredentialStore` — rows in, ciphertext out. Knows no plaintext, mirrors `SecretStore`. |
| `src/credentials/kinds.ts` | The three kinds, their fields, and their default variable names. One table, imported by server, runner and web. |
| `src/runner/materialise.ts` | Writes blocks to the per-run directory and builds the environment. |
| `src/runner/gradle-properties.ts` | Writes and sweeps the marked properties file in the clone. |
| `src/server/routes/credentials.ts` | REST surface for blocks. |
| `web/src/components/CredentialCard.tsx` | One block's card: upload, fields, variable names. |

**Modified:**

| File | Change |
|---|---|
| `src/db/schema.sql:63` | Add the `credential` table after `secret`. |
| `src/secrets/vault.ts` | Block accessors; `maskedValues` gains block passwords. |
| `src/server/permissions.ts:27-35` | Two route patterns in `REQUIRES_ADMIN`. |
| `src/server/app.ts` | Register routes; per-run directory accessor; `maskedValues` call site. |
| `src/runner/orchestrate.ts` | Wrap the body in `try`/`finally`; materialise and clean up. |
| `src/heuristics/android-signing.ts:29-42,82` | `conditionalOn` reports its scope. |
| `src/server/routes/readiness.ts:70-99` | A marked properties file counts as absent. |
| `src/heuristics/readiness.ts` | Blocks satisfy the checks; recommendations point at them; `API_KEY` stops matching `_P8`. |
| `src/cli/secret-import.ts:32-38` | Stop minting `APP_STORE_CONNECT_API_KEY_P8`. |
| `src/cli/secret.ts:301-306` | Advice inverted to match the design. |
| `web/src/pages/Secrets.tsx` | Three zones; `FILE_CREDENTIALS` removed; stale docstring at `:47` fixed. |
| `web/src/api.ts` | Block client methods. |

---

# Phase 1 — Storage

Nothing user-visible. At the end of this phase a block can be stored and read back, and no route can reach it.

### Task 1: The `credential` table and its store

**Files:**
- Modify: `src/db/schema.sql:63`
- Create: `src/db/credentials.ts`
- Test: `tests/db/credentials.test.ts`

- [ ] **Step 1: Add the table**

After the `secret` table (`src/db/schema.sql:63`), add:

```sql
-- A signing credential: a file plus the fields that make it usable. Separate
-- from `secret` because these are not key/value pairs — stored as loose rows,
-- nothing knew the parts belonged together, and deleting one left a half-dead
-- group no check could detect.
--
-- `fields_enc` is one encrypted JSON object rather than a column per field: the
-- three kinds do not share a shape, and a column per field would mean a
-- migration every time a kind gains one.
--
-- `var_names` is NOT encrypted. It holds variable names, never values, and the
-- interface has to display them.
CREATE TABLE IF NOT EXISTS credential (
  project_slug TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  file_enc     TEXT NOT NULL,
  fields_enc   TEXT NOT NULL,
  var_names    TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_slug, kind)
);
```

No migration code is needed: `openDatabase` re-runs `schema.sql` on every open (`src/db/open.ts:15`) and every statement is `IF NOT EXISTS`.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/db/credentials.test.ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";

function store(): CredentialStore {
  return new CredentialStore(openDatabase(":memory:"));
}

describe("CredentialStore", () => {
  it("stores and finds a block", () => {
    const s = store();
    s.set("popotheque", "android_keystore", {
      fileName: "release.jks",
      fileEnc: "cipher-a",
      fieldsEnc: "cipher-b",
      varNames: { path: "ANDROID_KEYSTORE_PATH" },
    });

    const found = s.find("popotheque", "android_keystore");
    expect(found).toMatchObject({
      kind: "android_keystore",
      fileName: "release.jks",
      fileEnc: "cipher-a",
      scope: "project",
      varNames: { path: "ANDROID_KEYSTORE_PATH" },
    });
  });

  it("lets a project block shadow a global one of the same kind", () => {
    const s = store();
    s.set(null, "apple_asc", { fileName: "g.p8", fileEnc: "g", fieldsEnc: "g", varNames: {} });
    s.set("popotheque", "apple_asc", { fileName: "p.p8", fileEnc: "p", fieldsEnc: "p", varNames: {} });

    expect(s.find("popotheque", "apple_asc")?.fileName).toBe("p.p8");
    expect(s.find("autre", "apple_asc")?.fileName).toBe("g.p8");
    expect(s.applicable("popotheque")).toHaveLength(1);
  });

  it("reports whether a removal happened", () => {
    const s = store();
    s.set(null, "play_service_account", { fileName: "a.json", fileEnc: "x", fieldsEnc: "y", varNames: {} });
    expect(s.remove(null, "play_service_account")).toBe(true);
    expect(s.remove(null, "play_service_account")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/db/credentials.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/credentials.js'`

- [ ] **Step 4: Write `CredentialStore`**

`src/db/credentials.ts`. Mirror `SecretStore` (`src/db/secrets.ts`) closely — same `GLOBAL = ""` convention, same `applicable()` shape, same "returns false when nothing matched" rule on `remove`. A reader who knows one should recognise the other.

The public shape:

```typescript
// Declared here in Task 1 and re-exported by `credentials/kinds.ts` in Task 2.
// If you would rather the domain module own it, move it there and import it
// back — but pick one direction and keep it.
export type CredentialKind = "apple_asc" | "android_keystore" | "play_service_account";

/** What a listing may expose. No ciphertext, no field values. */
export interface CredentialSummary {
  kind: CredentialKind;
  fileName: string;
  scope: "project" | "global";
  varNames: Record<string, string>;
  updatedAt: string;
}

export interface CredentialInput {
  fileName: string;
  fileEnc: string;
  fieldsEnc: string;
  varNames: Record<string, string>;
}

export class CredentialStore {
  constructor(private readonly db: Db) {}
  set(projectSlug: string | null, kind: CredentialKind, input: CredentialInput): void;
  /** Blocks that apply to a project, project scope winning over global. */
  applicable(projectSlug: string): (CredentialSummary & { fileEnc: string; fieldsEnc: string })[];
  find(projectSlug: string, kind: CredentialKind): (CredentialSummary & { fileEnc: string; fieldsEnc: string }) | undefined;
  list(projectSlug: string): CredentialSummary[];
  listGlobal(): CredentialSummary[];
  remove(projectSlug: string | null, kind: CredentialKind): boolean;
}
```

`varNames` is stored with `JSON.stringify` and read with `JSON.parse`. Keep the parse inside the store so no caller ever sees the raw column.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/db/credentials.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/credentials.ts tests/db/credentials.test.ts
git commit -m "feat(db): a credential is a file plus its fields"
```

---

### Task 2: The kinds table

**Files:**
- Create: `src/credentials/kinds.ts`
- Test: `tests/credentials/kinds.test.ts`

One module owns what a kind is made of, so the server, the runner, the readiness checks and the web UI cannot drift apart on it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/credentials/kinds.test.ts
import { describe, expect, it } from "vitest";
import { CREDENTIAL_KINDS, defaultVarNames, fieldsOf } from "../../src/credentials/kinds.js";

describe("credential kinds", () => {
  it("defaults Apple to the names fastlane itself reads", () => {
    expect(defaultVarNames("apple_asc")).toEqual({
      path: "APP_STORE_CONNECT_API_KEY_KEY_FILEPATH",
      key_id: "APP_STORE_CONNECT_API_KEY_KEY_ID",
      issuer_id: "APP_STORE_CONNECT_API_KEY_ISSUER_ID",
    });
  });

  it("gives the keystore a password name readiness already recognises", () => {
    // heuristics/readiness.ts:466 matches /(^|_)(KEYSTORE|STORE)_PASSWORD$/.
    // The block and the check must agree by construction, not by luck.
    expect(defaultVarNames("android_keystore").store_password).toMatch(
      /(^|_)(KEYSTORE|STORE)_PASSWORD$/,
    );
  });

  it("knows which fields are secret", () => {
    const fields = fieldsOf("android_keystore");
    expect(fields.find((f) => f.name === "store_password")?.secret).toBe(true);
    expect(fields.find((f) => f.name === "key_alias")?.secret).toBe(false);
  });

  it("covers every kind", () => {
    expect(CREDENTIAL_KINDS).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/credentials/kinds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```typescript
// src/credentials/kinds.ts
/**
 * What each kind of block is made of.
 *
 * One table rather than knowledge spread across the server, the runner, the
 * readiness checks and the interface: those four must agree on the field names
 * and the default variables, and four copies of an agreement is three too many.
 */
export interface FieldSpec {
  name: string;
  /** Kept out of the logs and never sent back to a browser. */
  secret: boolean;
  label: string;
}

export interface KindSpec {
  kind: CredentialKind;
  what: string;
  accept: string;
  fields: FieldSpec[];
  /** Exported variable names, overridable per block. */
  defaults: Record<string, string>;
}
```

Populate the three kinds from the spec's defaults table. `apple_asc` accepts `.p8`, `play_service_account` accepts `.json,application/json`, `android_keystore` accepts `.jks,.keystore`.

The Android defaults are Laneyard's own — nothing in fastlane reads a keystore by convention. Say so in a comment, and say why `ANDROID_KEYSTORE_PASSWORD` was chosen rather than invented freely.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/credentials/kinds.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/credentials/kinds.ts tests/credentials/kinds.test.ts
git commit -m "feat(credentials): one table says what each kind is made of"
```

---

### Task 3: Vault accessors

**Files:**
- Modify: `src/secrets/vault.ts:14-21`, and every construction site
- Test: `tests/secrets/vault-credentials.test.ts`

**How `Vault` reaches the rows, decided here so nobody invents it mid-loop.**
`Vault.open(home, store)` gains a third parameter: `Vault.open(home, secretStore, credentialStore)`. The store is injected, exactly as `SecretStore` already is — `Vault` keeps knowing nothing about `Db`, and the constructor stays the honest list of what it holds.

That touches 14 call sites: `src/main.ts:46`, `src/cli/secret.ts:167,260`, and eleven test files. Change them in this task's commit; a compile error in a test file is not a separate task.

`Vault` stays the only component that holds plaintext. The header comment at `vault.ts:6-12` makes that claim; adding a second decrypting site elsewhere would make it false.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/secrets/vault-credentials.test.ts
import { describe, expect, it } from "vitest";
// …open a Vault over an in-memory db, as tests/server/secrets.test.ts does…

describe("Vault credentials", () => {
  it("round-trips binary file bytes unchanged", async () => {
    const vault = await openTestVault();
    // A .jks is binary; cipher.ts takes a string, so bytes go through base64.
    const bytes = Buffer.from([0xfe, 0xed, 0x00, 0xff, 0x80, 0x7f]);

    await vault.setCredential("popotheque", "android_keystore", {
      fileName: "release.jks",
      fileBytes: bytes,
      fields: { store_password: "hunter2", key_alias: "upload", key_password: "hunter2" },
      varNames: defaultVarNames("android_keystore"),
    });

    const got = vault.resolveCredential("popotheque", "android_keystore");
    expect(got?.fileBytes.equals(bytes)).toBe(true);
    expect(got?.fields.store_password).toBe("hunter2");
  });

  it("never returns a secret field to a listing", () => {
    // list() exposes kind, file name, scope and variable names — nothing else.
    const summary = vault.listCredentials("popotheque")[0]!;
    expect(JSON.stringify(summary)).not.toContain("hunter2");
  });

  it("fails loudly when a block will not decrypt", async () => {
    // resolve() skips an unreadable secret on purpose — one variable lost beats
    // a lost build. A keystore gets no such leniency: skipping it costs a
    // debug-signed artifact that ships and is rejected days later.
    corruptStoredBlock("popotheque", "android_keystore");
    expect(() => vault.resolveCredential("popotheque", "android_keystore")).toThrow(
      /android_keystore/,
    );
  });

  it("includes block passwords in the values scrubbed from logs", () => {
    expect(vault.maskedValues("popotheque")).toContain("hunter2");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/secrets/vault-credentials.test.ts`
Expected: FAIL — `vault.setCredential is not a function`

- [ ] **Step 3: Implement**

Add to `Vault`: `setCredential`, `resolveCredential`, `listCredentials`, `listGlobalCredentials`, `removeCredential`. File bytes go `Buffer → base64 → encrypt`; fields go `JSON.stringify → encrypt`.

`resolveCredential` throws on a decryption failure, naming the kind. Put the contrast with `resolve()` in a comment: the leniency at `vault.ts:56-66` is deliberate and the difference here is deliberate too.

Extend `maskedValues()` (`vault.ts:100-105`) to append every field of every applicable block whose `FieldSpec.secret` is true. Its signature and its call site (`src/server/app.ts:146`) change together.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/secrets/vault-credentials.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Check nothing else broke**

Run: `npm test && npm run typecheck`
Expected: the suite passes. If `app.ts:146` no longer type-checks, that is the `maskedValues` call site — fix it now, not later.

- [ ] **Step 6: Commit**

```bash
git add src/secrets/vault.ts src/server/app.ts src/main.ts src/cli/secret.ts \
        tests/secrets/vault-credentials.test.ts tests/
git commit -m "feat(vault): blocks, and a keystore that fails loudly"
```

Name the test files you actually touched rather than `tests/` wholesale — the repository has uncommitted work in that tree.

---

# Phase 2 — API and interface

At the end of this phase a user can upload a block and see it, and only an admin can.

### Task 4: Routes and permissions

**Files:**
- Create: `src/server/routes/credentials.ts`
- Modify: `src/server/permissions.ts:27-35`, `src/server/app.ts`
- Test: `tests/server/credentials.test.ts`, `tests/server/permissions.test.ts`

- [ ] **Step 1: Write the failing permission test first**

Add to `tests/server/permissions.test.ts`, following the cases already there:

```typescript
it("keeps a builder out of the credential blocks", () => {
  expect(requiresAdmin("POST", "/api/projects/popotheque/credentials")).toBe(true);
  expect(requiresAdmin("DELETE", "/api/credentials/apple_asc")).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/server/permissions.test.ts`
Expected: FAIL — both return false.

- [ ] **Step 3: Add the patterns**

In `REQUIRES_ADMIN` (`src/server/permissions.ts:27`), beside the two secrets entries:

```typescript
  { method: "*", path: "/api/credentials" },
  { method: "*", path: "/api/projects/:slug/credentials" },
```

The list's premise, stated in its own comment, is that it names every credential route. These are credential routes.

- [ ] **Step 4: Run it**

Run: `npx vitest run tests/server/permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

`tests/server/credentials.test.ts`, modelled on `tests/server/secrets.test.ts`. Cover: upload returns 201 and the block appears in the listing; a listing never contains a secret field value or ciphertext; unknown kind is 400; delete of an absent block is 404; a project block shadows a global one.

Upload is `multipart/form-data` (file plus fields). Check how Fastify is configured in `src/server/app.ts` — if no multipart plugin is registered, prefer a JSON body with the file base64-encoded rather than adding a dependency. The interface encodes it; the route decodes it. Note the choice in the route's header comment.

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run tests/server/credentials.test.ts`
Expected: FAIL — 404 on every route.

- [ ] **Step 7: Implement the routes and register them**

`GET`/`PUT`/`DELETE` for both scopes, delegating entirely to `Vault`. Validate `kind` against `CREDENTIAL_KINDS` and the fields against `fieldsOf(kind)` — a block is validated whole, which is the point of it being an entity.

- [ ] **Step 8: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/routes/credentials.ts src/server/permissions.ts src/server/app.ts tests/server/credentials.test.ts tests/server/permissions.test.ts
git commit -m "feat(server): credential blocks, admin only"
```

---

### Task 5: The three zones

**Files:**
- Modify: `web/src/api.ts`, `web/src/pages/Secrets.tsx:14-42,47,399-456`
- Create: `web/src/components/CredentialCard.tsx`

No test framework covers the web tree today; verify by running it.

- [ ] **Step 1: Add the client methods**

In `web/src/api.ts`, beside the secret methods: `listCredentials`, `putCredential`, `deleteCredential`.

- [ ] **Step 2: Write `CredentialCard.tsx`**

One card per kind: file drop zone (`accept` from `kinds.ts`), one input per field (`type="password"` where `secret`), and the exported variable names pre-filled with the defaults and editable.

The keystore card also carries the two settings from Task 8 — where the properties file goes, and the property names inside it — pre-filled from detection. Present them as answers Laneyard has proposed, not as questions the user must research: the point of asking at configuration time is that it replaces a silent guess, not that it adds homework.

The card shows the stored file's name, never its contents. A stored block shows `••••••` for secret fields, matching the marker the logs use and the rule the page already follows.

- [ ] **Step 3: Restructure the page**

`web/src/pages/Secrets.tsx`:
- Delete `FILE_CREDENTIALS`, `FILE_CREDENTIAL_KEYS` (`:14-42`) and the "from a file" section (`:399-456`). Superseded.
- Split the existing list into **variables** (`masked === false`) and **secrets** (`masked === true`). The criterion is the existing flag — `vault.ts:76-80` already argues this is the identifier/secret line. No new concept.
- Add a **signing** section rendering one `CredentialCard` per kind.
- Fix the docstring at `:47`. It says there is no reveal button and no route behind it; both are now false (`api.revealSecret`, `src/server/routes/secrets.ts:68,105`). Describe what is true: values a user marked secret are never sent back, and the ones they did not can be read.

- [ ] **Step 4: See it work**

Run: `npm run dev` and `npm run dev:web`, then upload a `.p8` to a project and reload the page. The block survives the reload, the file name shows, no field value appears in the network response.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/components/CredentialCard.tsx web/src/pages/Secrets.tsx
git commit -m "feat(web): variables, secrets, and signing"
```

---

# Phase 3 — The run

At the end of this phase a lane reads a real file path. Nothing is left on disk afterwards.

### Task 6: Materialisation and cleanup

**Files:**
- Create: `src/runner/materialise.ts`
- Modify: `src/runner/orchestrate.ts:19-20`, `src/server/app.ts:93-101`
- Test: `tests/runner/materialise.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/runner/materialise.test.ts
describe("materialise", () => {
  it("writes each block and exports its configured path", async () => {
    const { env, dir } = await materialiseCredentials(vault, "popotheque", runDir);
    expect(env.ASC_KEY_FILEPATH).toBe(join(dir, "AuthKey.p8"));
    expect(await readFile(env.ASC_KEY_FILEPATH!)).toEqual(originalBytes);
  });

  it("writes files only the owner can read", async () => {
    const { env } = await materialiseCredentials(vault, "popotheque", runDir);
    expect((await stat(env.ASC_KEY_FILEPATH!)).mode & 0o777).toBe(0o600);
  });

  it("exports the overridden names, not the defaults", async () => {
    // The whole point: popotheque's Fastfile reads ASC_KEY_FILEPATH, a private
    // name fastlane does not know, and that repository cannot be edited.
    expect(env.APP_STORE_CONNECT_API_KEY_KEY_FILEPATH).toBeUndefined();
  });

  it("leaves nothing behind when cleaned up", async () => {
    const { cleanup, dir } = await materialiseCredentials(vault, "popotheque", runDir);
    await cleanup();
    expect(existsSync(dir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/runner/materialise.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`materialiseCredentials(vault, slug, runDir)` creates `<runDir>/secrets` at `0700`, writes each applicable block's file at `0600`, and returns `{ env, dir, cleanup }`.

Add the directory to the app context beside `artifactsDir` (`src/server/app.ts:93-101`, where `workspaces/<slug>`, `artifacts/<runId>` and `logs/` already live). Name it `runSecretsDir(runId)` so the two conventions stay visible together. It is **not** inside the clone: `workspace.ts:14` says the clone is kept between runs, and credentials must not be.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/runner/materialise.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into the run**

`executeRun` receives pre-resolved `secrets` and `maskedValues` (`orchestrate.ts:31-34`), not a `Vault` — a deliberate boundary worth keeping. So `materialiseCredentials` is called by `app.ts`, and `ExecuteRunOptions` gains the resulting `{ env, cleanup }` pair rather than a vault.

`executeRun` has no `try`/`finally` today and returns early in six places. Wrap the body so `cleanup()` runs on every path, and merge `env` into the environment already being built.

- [ ] **Step 6: Prove cleanup survives a failure**

Add to `tests/runner/materialise.test.ts` (or a run-level test beside it): a run whose lane exits non-zero still leaves no secrets directory.

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runner/materialise.ts src/runner/orchestrate.ts src/server/app.ts tests/runner/materialise.test.ts
git commit -m "feat(runner): blocks become files for the length of a run"
```

---

# Phase 4 — The Gradle properties file

At the end of this phase a Flutter release build signs with the real key. This is the phase where a half-landed version could sign wrongly — do not stop inside it.

### Task 7: `conditionalOn` reports its scope

**Files:**
- Modify: `src/heuristics/android-signing.ts:29-42,82`
- Modify: `src/heuristics/readiness.ts:731-751` — `checkReleaseSigning` interpolates `conditionalOn` into five user-facing strings. A struct keeps type-checking there and renders `[object Object]`.
- Modify: `src/server/routes/readiness.ts:87-90`
- Test: `tests/heuristics/android-signing.test.ts:29`, `tests/heuristics/readiness.test.ts:798,808,817` — all three build facts with `conditionalOn: "key.properties"` and stop compiling.

`PROPERTIES_FILE` runs over the whole source and cannot tell `rootProject.file("key.properties")` (meaning `android/`) from a module-level `file(...)` (meaning `android/app/`). Without the distinction the file lands in the wrong place half the time.

- [ ] **Step 1: Write the failing test**

```typescript
it("tells rootProject scope from module scope", () => {
  const root = parseAndroidSigning(`
    val f = rootProject.file("key.properties")
    android { buildTypes { release { signingConfig = signingConfigs.getByName("debug") } } }
  `);
  expect(root.conditionalOn).toEqual({ name: "key.properties", scope: "root" });

  const module = parseAndroidSigning(`
    val f = file("signing.properties")
    android { buildTypes { release { signingConfig = signingConfigs.debug } } }
  `);
  expect(module.conditionalOn).toEqual({ name: "signing.properties", scope: "module" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/heuristics/android-signing.test.ts`
Expected: FAIL — `conditionalOn` is a bare string.

- [ ] **Step 3: Implement**

`conditionalOn` becomes `{ name, scope } | null`. Update `SigningFacts`, `NO_SIGNING_FACTS`, and the regex so it captures whether `rootProject.` preceded `file(`.

Then fix the consumer at `src/server/routes/readiness.ts:87-90`, which resolves two levels up from the build file unconditionally, and any readiness message quoting the name.

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/heuristics/android-signing.ts src/heuristics/readiness.ts \
        src/server/routes/readiness.ts \
        tests/heuristics/android-signing.test.ts tests/heuristics/readiness.test.ts
git commit -m "fix(android): a properties file has a place, not just a name"
```

---

### Task 8: Write, mark and sweep

**Files:**
- Create: `src/runner/gradle-properties.ts`
- Modify: `src/runner/orchestrate.ts`
- Test: `tests/runner/gradle-properties.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
const MARKER = "# written by laneyard, do not commit";

describe("gradle properties", () => {
  it("writes the four documented keys, pointing at the materialised keystore", async () => {
    await writeGradleProperties({ clone, facts, block, keystorePath: "/run/x/release.jks" });
    const text = await readFile(join(clone, "android/key.properties"), "utf8");
    expect(text.split("\n")[0]).toBe(MARKER);
    expect(text).toContain("storeFile=/run/x/release.jks");
    expect(text).toContain("keyAlias=upload");
  });

  it("writes nothing when the build does not fall back to the debug key", async () => {
    // The rule: Laneyard writes the file only where its absence would ship a
    // debug-signed artifact.
    await writeGradleProperties({ ...args, facts: { releaseCanUseDebugKey: false, conditionalOn: null } });
    expect(existsSync(join(clone, "android/key.properties"))).toBe(false);
  });

  it("never touches a file it did not write", async () => {
    await writeFile(target, "storePassword=the user's own\n");
    await writeGradleProperties(args);
    expect(await readFile(target, "utf8")).toBe("storePassword=the user's own\n");
  });

  it("sweeps a marked leftover from a killed run", async () => {
    await writeFile(target, `${MARKER}\nstorePassword=leaked\n`);
    await sweepGradleProperties(clone, facts);
    expect(existsSync(target)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/runner/gradle-properties.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`writeGradleProperties` writes only when all three hold: an `android_keystore` block applies, `releaseCanUseDebugKey` is true, and a properties path is known. Mode `0600`.

**Two things are configuration, not deduction.** Per *Asking is allowed. Requiring is not.* in the spec, the `android_keystore` block gains two optional settings, both pre-filled from detection and both correctable by the user:

- `properties_path` — where the file goes. Detection proposes it from `conditionalOn.scope`; a parser that cannot tell the scope leaves the field for the user rather than picking wrong.
- `property_names` — the keys inside it, defaulting to the Flutter documentation's `storeFile` / `storePassword` / `keyPassword` / `keyAlias`. A project reading `keystoreProperties["alias"]` corrects the field; it does not touch its build script.

Task 2 shipped `kinds.ts` before this was decided, so add both here, in `src/credentials/kinds.ts` and the block's stored `varNames` sibling.

The property names — `storeFile`, `storePassword`, `keyPassword`, `keyAlias` — are the Flutter documentation's, and a convention rather than a reading: `conditionalOn` gives the file's name, not the names inside it. Say so in the header comment, because readiness will have to say it to the user.

`sweepGradleProperties` removes the file **only** if its first line is the marker.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/runner/gradle-properties.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: One lookup, shared**

`writeGradleProperties` needs a `parseAndroidSigning` result and the Gradle root. Nothing in `src/runner/` reads the build script today: the four-candidate search and the `appRoot` join exist only in `src/server/routes/readiness.ts:79-90`.

**Do not re-derive it in the runner.** If the two searches ever pick different build files, the properties file lands where readiness is not looking — a build that signs wrongly and reports green, which is the precise failure this phase exists to prevent.

Extract the search into `src/heuristics/android-root.ts`, returning the build file, the Gradle root and the parsed facts, and have both the readiness route and the runner call it. Add a test that both callers resolve the same path for a project with two candidate build files.

- [ ] **Step 6: Wire into the run**

Sweep at preparation, write after materialisation, remove in the same `finally` as the secrets directory.

- [ ] **Step 7: Commit**

```bash
git add src/runner/gradle-properties.ts src/runner/orchestrate.ts \
        src/heuristics/android-root.ts src/server/routes/readiness.ts \
        tests/runner/gradle-properties.test.ts
git commit -m "feat(runner): supply the file the build already asks for"
```

---

### Task 9: Readiness does not read its own writing

**Files:**
- Modify: `src/server/routes/readiness.ts:70-99`
- Test: `tests/server/readiness.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("counts a file Laneyard wrote as absent", async () => {
  await writeFile(target, `# written by laneyard, do not commit\nstoreFile=/x\n`);
  const res = await readiness(app, "popotheque");
  // Otherwise a leftover turns the warning into "present, so the release key is
  // used" — a green verdict Laneyard manufactured for itself.
  expect(res.signingFilePresent).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/server/readiness.test.ts`
Expected: FAIL — `true`.

- [ ] **Step 3: Implement**

Replace the bare `exists()` at `:87-90` with a read of the first line.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/readiness.ts tests/server/readiness.test.ts
git commit -m "fix(readiness): do not read our own writing"
```

---

# Phase 5 — Readiness, CLI, and popotheque

At the end of this phase the product says one thing rather than two.

### Task 10: The checks learn about blocks

**Files:**
- Modify: `src/heuristics/readiness.ts:215,219,260,466-545,553-565`
- Test: `tests/heuristics/readiness.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
it("stops asking for a password the user already gave", () => {
  // checkAndroidKeystore warned when no /(^|_)(KEYSTORE|STORE)_PASSWORD$/ key
  // was stored. A user who created a block would be told to duplicate it.
  const check = checkAndroidKeystore({ ...facts, blocks: ["android_keystore"], secretKeys: [] });
  expect(check.status).not.toBe("warn");
});

it("stops greening a name no lane can see", () => {
  // API_KEY is /^APP_STORE_CONNECT_API_KEY/ and prefix-matches the dead
  // APP_STORE_CONNECT_API_KEY_P8, which fastlane never reads.
  const check = checkAppStoreConnect({ ...facts, secretKeys: ["APP_STORE_CONNECT_API_KEY_P8"] });
  expect(check.status).toBe("warn");
  expect(check.detail).toMatch(/no lane can see|block/i);
});

it("still accepts the old loose secrets", () => {
  const check = checkPlayStore({ ...facts, secretKeys: ["SUPPLY_JSON_KEY_DATA"] });
  expect(check.status).toBe("ok");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/heuristics/readiness.test.ts`

- [ ] **Step 3: Implement**

Pass applicable block kinds into the checks. Then:
- `checkAndroidKeystore` (`:466-545`): a block satisfies it; the recommendation becomes the block, not `ANDROID_KEYSTORE_PASSWORD` as a loose secret.
- `checkPlayStore` (`:553-565`): recommend the Play block instead of `SUPPLY_JSON_KEY_DATA`. Keep accepting `/^SUPPLY_JSON_KEY/`.
- `checkAppStoreConnect` (`:215,219,260`): narrow `API_KEY` so it no longer matches the `_P8` suffix, and report a stored `_P8` as a value no lane can see, offering the block.
- `checkReleaseSigning` (`:735-742`): today it tells the user to supply the keystore through the environment and make a missing key an error — that is, to rewrite their `build.gradle.kts`. Under the governing constraint that is not Laneyard's to ask. With a keystore block present it states what Laneyard will do: supply the properties file, naming the four assumed keys. Without one, it says a block is missing — never that the build script is wrong.
- Where a properties file will be supplied, say so, and name the four assumed keys. The assumption is stated, not hidden.

- **A block is required by a lane, never by a platform.** A run that only builds an artifact needs the keystore and nothing else. Derive each check's requirement from the lane's actions — the introspection that already feeds `ASC_KEY_ACTIONS` and `PLAY_KEY_ARGS` — and report a missing block that no lane uses as *not needed here* rather than as a warning.

Two tests worth writing, because both constraints are easy to honour once and lose later:

```typescript
it("does not ask a build-only project for a service account", () => {
  // Nothing is uploaded anywhere, so nothing needs uploading credentials.
  const checks = readiness({ ...facts, lanes: [buildOnlyLane], blocks: [] });
  expect(byId(checks, "playStore").status).not.toBe("warn");
});

it("never tells the user to edit their own project", () => {
  for (const check of every(checks)) {
    expect(check.recommendation ?? "").not.toMatch(/rather than|edit|change your|in the lane with/i);
  }
});
```

Existing installations keep working: every check accepts either route, and recommends a block only when neither is present. The single exception is `_P8`, which never worked.

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/heuristics/readiness.ts tests/heuristics/readiness.test.ts
git commit -m "feat(readiness): recommend the block, and stop greening a dead name"
```

---

### Task 11: The CLI stops contradicting the design

**Files:**
- Modify: `src/cli/secret-import.ts:32-38`, `src/cli/secret.ts:301-306`
- Test: `tests/cli/secret-import.test.ts`

`secret import` maps `ASC_KEY_FILEPATH` and `APP_STORE_CONNECT_API_KEY_PATH` onto `APP_STORE_CONNECT_API_KEY_P8` — minting the one name this work declares dead. And `secret.ts:301-306` advises pointing lanes at contents rather than paths, which inverts the design: blocks materialise a real file precisely so `key_filepath` lanes keep working untouched.

- [ ] **Step 1: Write the failing test**

The mapping is the `PATH_TO_CONTENTS` record at `src/cli/secret-import.ts:32`, read at `:107` — there is no function to call yet. Either export one or assert against the record:

```typescript
it("does not mint a name fastlane never reads", () => {
  expect(Object.values(PATH_TO_CONTENTS)).not.toContain("APP_STORE_CONNECT_API_KEY_P8");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/cli/secret-import.test.ts`

- [ ] **Step 3: Implement**

Point the import at the Apple block instead: a `.p8` path in a `.env` becomes a suggestion to create the block, not a secret under a dead name.

Rewrite the advice at `secret.ts:301-306`. It currently tells the user to change `key_filepath:` to `key_content:` in their lanes — homework Laneyard exists to remove. The path forms are the supported ones now, precisely because blocks materialise real files. Say that instead: nothing in their lanes needs to change.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/secret-import.ts src/cli/secret.ts tests/cli/secret-import.test.ts
git commit -m "fix(cli): say the same thing as the rest of the product"
```

---

### Task 12: `laneyard.yml` for popotheque, and the docs

**Files:**
- Modify: `/Users/martin/Projets/popotheque/laneyard.yml` — **it already exists**
- Modify: `README.md`, `CHANGELOG.md`, the landing page

**`/Users/martin/Projets/popotheque` is not yours to change beyond that one file.** Do not touch `app/android/app/build.gradle.kts`, and do not commit anything in that repository without being asked. The file is currently untracked there.

**`laneyard.yml` is optional.** Build settings come "from the repository or the server" (`src/config/schema.ts:3`), so a project can be configured entirely server-side. The file exists here because this one is already using it — not because Laneyard requires a project to carry anything.

- [ ] **Step 1: Reconcile the existing file, do not overwrite it**

It reads today:

```yaml
fastlane_dir: app/fastlane
runtime: system
artifact_globs:
  - app/**/*.ipa
  - app/**/*.app.dSYM.zip
  - app/**/*.apk
  - app/**/*.aab
platforms:
  - ios
  - android
```

**Keep `runtime: system`.** The schema default is `bundle` (`src/config/schema.ts:6`), and that project's fastlane comes from Homebrew — its own `flutter()` helper unsets `GEM_HOME`/`GEM_PATH` for exactly that reason. Dropping the line changes how every lane is invoked and would break the verification run two steps below.

Keep the existing globs too; they are broader than needed and that costs nothing. The only addition:

```yaml
required_secrets: [APP_VERSION, SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT]
```

- [ ] **Step 2: Configure its blocks in Laneyard**

In the interface, not in the file. Apple and Play take the names that Fastfile already reads — `ASC_KEY_FILEPATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `SUPPLY_JSON_KEY`. The keystore block keeps the defaults: no lane reads those names, Gradle receives them through the properties file.

- [ ] **Step 3: Verify against the real project**

Run an Android build of popotheque through Laneyard, then check the signer:

```bash
apksigner verify --print-certs <the .aab or .apk> | grep "Signer #1 certificate DN"
```

Expected: the project's own upload key. `CN=Android Debug` means the properties file did not land — check its path against `conditionalOn.scope`.

Then confirm the clone is clean: no `key.properties` remains, and `git -C <clone> status` shows nothing new.

- [ ] **Step 4: README and changelog**

This repository's habit is that the README and the landing page are checked against any change in what the product claims. Blocks change it: the README's account of storing credentials is now wrong wherever it describes contents-only storage.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: credentials are blocks now"
```

---

## Done when

- A `.p8`, a service account JSON and a keystore can be uploaded, and only by an admin.
- A run exports the configured names, and leaves no file behind on success, on failure, or after a kill.
- A Flutter release build signs with the upload key, verified with `apksigner`.
- Readiness recommends blocks, accepts the old loose secrets, and no longer greens `APP_STORE_CONNECT_API_KEY_P8`.
- `npm test` and `npm run typecheck` pass.

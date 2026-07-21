# Laneyard — Milestone 1: the full thread

> This is the implementation plan followed for milestone 1. It is kept as a record of the
> decisions made and the traps found along the way; it is not maintained.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare a project in `config.yml`, clone it, list its lanes, trigger one, follow its output live in the browser, and download the produced artifact.

**Architecture:** Fastify server in TypeScript. Configuration lives in YAML files, never in the database; SQLite only keeps execution state. All fastlane knowledge comes from a Ruby script launched inside the project's bundle, which returns JSON. Runs execute inside a pseudo-terminal, their output going simultaneously to a log file and to browsers connected over WebSocket.

**Tech Stack:** Node 22+ / TypeScript ESM · Fastify 5 · better-sqlite3 · node-pty · zod · yaml · tinyglobby · Vitest · React 19 + Vite · Ruby with Prism (included since Ruby 3.3)

**Reference spec:** `docs/superpowers/specs/2026-07-21-laneyard-design.md`

**Out of scope for this plan** (milestones 2 to 5): secret redaction, vault, queue, cancellation, timeout, CI Readiness, Fastfile editor, notifications, purge, themes, README.

---

## File structure

```
src/
  config/
    schema.ts        zod schemas for config.yml and laneyard.yml, derived types
    load.ts          Reading + validation of a YAML file → typed object or error
    resolve.ts       Merge of laneyard.yml > project block > defaults, with provenance
    store.ts         Live config state: loading, watching, access
  db/
    schema.sql       Table DDL
    open.ts          Opening, migrations, pragmas
    runs.ts          Reading/writing runs, steps, and artifacts
    cache.ts         Introspection cache
  git/
    workspace.ts     Initial clone, fetch, checkout, current SHA, dirty state
  sidecar/
    bridge.ts        Invoking the Ruby script, JSON parsing, typed errors
    lanes.ts         Reading lanes with a cache indexed on the fastlane_dir hash
  logs/
    store.ts         Append-only writing and reading from an offset
  heuristics/
    error-summary.ts Extraction of a readable failure cause — named knowledge, isolated
  runner/
    pty.ts           Launching a process in a PTY, output stream, exit code
    live-steps.ts    Detecting step separators and their byte offset
    report.ts        Reading fastlane/report.xml
    artifacts.ts     Collection by patterns
    orchestrate.ts   Full chaining of a run and state transitions
  sidecar/
    ruby-env.ts      Resolving a Ruby environment able to load fastlane
  cli/
    detect.ts        Inspecting an existing project: fastlane, platform, git
    add.ts           Writing the project block into config.yml, comments preserved
  server/
    app.ts           Building the Fastify instance
    auth.ts          Cookie session, scrypt password
    ws.ts            Broadcasting log chunks per run
    routes/
      projects.ts    Project list, a project's lanes
      runs.ts        Triggering, viewing, log, artifacts
  main.ts            Entry point: loads config, opens the database, starts
ruby/
  introspect.rb      Sidecar: lanes / actions / parse commands
web/                 React application (Vite)
tests/
  fixtures/
    fake-fastlane/   Fake executable replaying recorded output
    repos/           Generators for test git repositories
```

Each module exposes pure functions as much as possible; I/O (files,
processes, database) is concentrated in `store.ts`, `open.ts`, `pty.ts`, and `workspace.ts`, which
makes the rest testable without a build machine.

---

### Task 1: Project skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/main.ts`, `tests/smoke.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { version } from "../src/main.js";

describe("laneyard", () => {
  it("exposes its version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npm test`
Expected: failure — the `src/main.ts` module doesn't exist.

- [ ] **Step 3: Create the skeleton**

`package.json`:

```json
{
  "name": "laneyard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.json && cp src/db/schema.sql dist/src/db/ && npm run build:web",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.0",
    "@fastify/static": "^8.0.0",
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^11.7.0",
    "fastify": "^5.2.0",
    "node-pty": "^1.0.0",
    "tinyglobby": "^0.2.10",
    "yaml": "^2.7.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

> `tsx` rather than `node --experimental-strip-types`: native type stripping doesn't rewrite
> `./x.js` specifiers to `./x.ts`, and that's the form `moduleResolution: NodeNext` requires.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
```

`.gitignore` — add to the existing lines:

```
node_modules/
dist/
*.db
```

`src/main.ts`:

```ts
export const version = "0.1.0";
```

- [ ] **Step 4: Install and verify the test passes**

Run: `npm install && npm test`
Expected: 1 test passing. `better-sqlite3` and `node-pty` compile native modules — if
the install fails, check that the C++ build tools are present.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: TypeScript, Vitest skeleton and dependencies"
```

---

### Task 2: Server configuration schema and loading

**Files:**
- Create: `src/config/schema.ts`, `src/config/load.ts`, `tests/config/load.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/config/load.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadServerConfig } from "../../src/config/load.js";

async function withConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "laneyard-"));
  const path = join(dir, "config.yml");
  await writeFile(path, yaml, "utf8");
  return path;
}

const minimal = `
server:
  password_hash: "scrypt$aaa$bbb"
projects:
  - slug: sample-ios
    git_url: git@github.com:martin/sample.git
`;

describe("loadServerConfig", () => {
  it("applies the server's default values", async () => {
    const res = await loadServerConfig(await withConfig(minimal));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.server.port).toBe(7890);
    expect(res.config.server.bind).toBe("0.0.0.0");
    expect(res.config.server.max_concurrent_runs).toBe(1);
    expect(res.config.server.retention).toEqual({ runs: 50, artifact_days: 30 });
  });

  it("derives a project's name from its slug", async () => {
    const res = await loadServerConfig(await withConfig(minimal));
    if (!res.ok) throw new Error("expected valid");
    expect(res.config.projects[0]!.name).toBe("sample-ios");
    expect(res.config.projects[0]!.default_branch).toBe("main");
  });

  it("refuses two projects sharing the same slug", async () => {
    const res = await loadServerConfig(
      await withConfig(`
server: { password_hash: "x" }
projects:
  - { slug: a, git_url: u1 }
  - { slug: a, git_url: u2 }
`),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/slug/i);
  });

  it("refuses a slug that isn't usable in a path", async () => {
    const res = await loadServerConfig(
      await withConfig(`
server: { password_hash: "x" }
projects:
  - { slug: "../evil", git_url: u }
`),
    );
    expect(res.ok).toBe(false);
  });

  it("reports a readable error on invalid YAML", async () => {
    const res = await loadServerConfig(await withConfig("server: {"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.length).toBeGreaterThan(0);
  });

  it("reports a missing file without throwing", async () => {
    const res = await loadServerConfig("/does/not/exist/config.yml");
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/config/load.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Write the schema and the loader**

`src/config/schema.ts`:

```ts
import { z } from "zod";

/** Build behaviour settings. They can come from the repository or the server. */
export const projectSettingsSchema = z.object({
  fastlane_dir: z.string().default("fastlane"),
  runtime: z.enum(["bundle", "system"]).default("bundle"),
  timeout_minutes: z.number().int().positive().default(60),
  interactive_default: z.boolean().default(false),
  artifact_globs: z.array(z.string()).default([]),
  required_secrets: z.array(z.string()).default([]),
  retention: z
    .object({
      runs: z.number().int().positive(),
      artifact_days: z.number().int().positive(),
    })
    .optional(),
});

/** Same vocabulary, but everything is optional in the files. */
export const projectSettingsInputSchema = projectSettingsSchema.partial();

/** A slug is used as a folder name and a URL segment. */
const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug: lowercase letters, digits and hyphens only");

export const projectEntrySchema = projectSettingsInputSchema.extend({
  slug: slugSchema,
  name: z.string().optional(),
  git_url: z.string().min(1),
  default_branch: z.string().default("main"),
  git_auth: z
    .object({
      kind: z.enum(["none", "ssh_key", "token"]),
      /** File path if kind is ssh_key, secret name if kind is token. */
      ref: z.string().optional(),
    })
    .default({ kind: "none" }),
  color: z.string().default("green"),
  notify_browser: z.boolean().default(true),
  webhook_url: z.string().optional(),
});

export const serverConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(7890),
    bind: z.string().default("0.0.0.0"),
    password_hash: z.string().min(1),
    max_concurrent_runs: z.number().int().positive().default(1),
    retention: z
      .object({
        runs: z.number().int().positive().default(50),
        artifact_days: z.number().int().positive().default(30),
      })
      .default({ runs: 50, artifact_days: 30 }),
  }),
  projects: z.array(projectEntrySchema).default([]),
});

/** Content of laneyard.yml: build behaviour only. */
export const repoConfigSchema = projectSettingsInputSchema;

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema> & { name: string };
export type ServerConfig = Omit<z.infer<typeof serverConfigSchema>, "projects"> & {
  projects: ProjectEntry[];
};
export type RepoConfig = z.infer<typeof repoConfigSchema>;
```

`src/config/load.ts`:

```ts
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import { repoConfigSchema, serverConfigSchema } from "./schema.js";
import type { RepoConfig, ServerConfig } from "./schema.js";

export type LoadResult<T> = { ok: true; config: T } | { ok: false; error: string };

/** Reads and validates a YAML file. Never fails by throwing: the caller decides. */
// `ZodType<T, any, any>` and not `ZodType<T>`: on a schema with `.default()` fields,
// the input type differs from the output type, and TypeScript then infers `T` from the input
// — so with optional fields. Neutralizing the last two parameters forces
// inference on the output, the only one relevant here.
async function loadYamlFile<T>(path: string, schema: ZodType<T, any, any>): Promise<LoadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    return { ok: false, error: `Could not read ${path}: ${(cause as Error).message}` };
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (cause) {
    return { ok: false, error: `Invalid YAML in ${path}: ${(cause as Error).message}` };
  }

  const parsed = schema.safeParse(data ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Invalid configuration in ${path} — ${details}` };
  }
  return { ok: true, config: parsed.data };
}

export async function loadServerConfig(path: string): Promise<LoadResult<ServerConfig>> {
  const res = await loadYamlFile(path, serverConfigSchema);
  if (!res.ok) return res;

  const seen = new Set<string>();
  for (const p of res.config.projects) {
    if (seen.has(p.slug)) {
      return { ok: false, error: `Invalid configuration in ${path} — duplicate slug: ${p.slug}` };
    }
    seen.add(p.slug);
  }

  // The display name falls back to the slug rather than being optional everywhere downstream.
  const projects = res.config.projects.map((p) => ({ ...p, name: p.name ?? p.slug }));
  return { ok: true, config: { ...res.config, projects } };
}

export async function loadRepoConfig(path: string): Promise<LoadResult<RepoConfig>> {
  return loadYamlFile(path, repoConfigSchema);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/config/load.test.ts`
Expected: 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/config tests/config
git commit -m "feat(config): schema and loading for config.yml"
```

---

### Task 3: Resolving a project's configuration

The precedence described in the spec — the repository's `laneyard.yml`, then the project's block,
then the defaults — with the provenance of each field, which the interface will display later.

**Files:**
- Create: `src/config/resolve.ts`, `tests/config/resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/config/resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveProjectSettings } from "../../src/config/resolve.js";
import type { ProjectEntry } from "../../src/config/schema.js";

const entry = (over: Partial<ProjectEntry> = {}): ProjectEntry => ({
  slug: "p",
  name: "p",
  git_url: "u",
  default_branch: "main",
  git_auth: { kind: "none" },
  color: "green",
  notify_browser: true,
  ...over,
});

describe("resolveProjectSettings", () => {
  it("falls back to the defaults when nothing is set", () => {
    const r = resolveProjectSettings(entry(), null);
    expect(r.settings.fastlane_dir).toBe("fastlane");
    expect(r.settings.timeout_minutes).toBe(60);
    expect(r.provenance.fastlane_dir).toBe("default");
  });

  it("the project's block wins over the defaults", () => {
    const r = resolveProjectSettings(entry({ timeout_minutes: 15 }), null);
    expect(r.settings.timeout_minutes).toBe(15);
    expect(r.provenance.timeout_minutes).toBe("server");
  });

  it("the repository wins over the project's block", () => {
    const r = resolveProjectSettings(entry({ timeout_minutes: 15 }), { timeout_minutes: 90 });
    expect(r.settings.timeout_minutes).toBe(90);
    expect(r.provenance.timeout_minutes).toBe("repo");
  });

  it("mixes provenances field by field", () => {
    const r = resolveProjectSettings(entry({ runtime: "system" }), {
      artifact_globs: ["build/*.ipa"],
    });
    expect(r.settings.runtime).toBe("system");
    expect(r.provenance.runtime).toBe("server");
    expect(r.settings.artifact_globs).toEqual(["build/*.ipa"]);
    expect(r.provenance.artifact_globs).toBe("repo");
    expect(r.provenance.fastlane_dir).toBe("default");
  });

  it("treats an empty array as a defined value, not as an absence", () => {
    const r = resolveProjectSettings(entry(), { artifact_globs: [] });
    expect(r.provenance.artifact_globs).toBe("repo");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/config/resolve.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the resolution**

`src/config/resolve.ts`:

```ts
import { projectSettingsSchema } from "./schema.js";
import type { ProjectEntry, ProjectSettings, RepoConfig } from "./schema.js";

export type Origin = "repo" | "server" | "default";
export type Provenance = Record<keyof ProjectSettings, Origin>;

const SETTING_KEYS = Object.keys(projectSettingsSchema.shape) as (keyof ProjectSettings)[];

/**
 * Merges the three sources field by field.
 * `undefined` means "not set"; any other value, including an empty array
 * or `false`, is an explicit decision by the user.
 */
export function resolveProjectSettings(
  entry: ProjectEntry,
  repo: RepoConfig | null,
): { settings: ProjectSettings; provenance: Provenance } {
  const chosen: Record<string, unknown> = {};
  const provenance = {} as Provenance;

  for (const key of SETTING_KEYS) {
    const fromRepo = repo?.[key];
    const fromServer = (entry as Record<string, unknown>)[key];

    if (fromRepo !== undefined) {
      chosen[key] = fromRepo;
      provenance[key] = "repo";
    } else if (fromServer !== undefined) {
      chosen[key] = fromServer;
      provenance[key] = "server";
    } else {
      provenance[key] = "default";
    }
  }

  // The schema applies the defaults for anything still absent.
  const settings = projectSettingsSchema.parse(chosen);
  return { settings, provenance };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/config/resolve.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/config/resolve.ts tests/config/resolve.test.ts
git commit -m "feat(config): resolution with precedence and provenance"
```

---

### Task 4: Database and access to runs

**Files:**
- Create: `src/db/schema.sql`, `src/db/open.ts`, `src/db/runs.ts`, `tests/db/runs.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/db/runs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";

function store(): RunStore {
  return new RunStore(openDatabase(":memory:"));
}

describe("RunStore", () => {
  it("creates a queued run and reads it back", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "beta", platform: "ios", params: { v: "1.2" } });
    const run = s.get(id);
    expect(run?.status).toBe("queued");
    expect(run?.params).toEqual({ v: "1.2" });
    expect(run?.startedAt).toBeNull();
  });

  it("timestamps the transition to running and to a terminal state", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });
    s.markRunning(id, { branch: "main", commitSha: "abc123" });
    expect(s.get(id)?.startedAt).not.toBeNull();
    expect(s.get(id)?.commitSha).toBe("abc123");

    s.finish(id, { status: "success", exitCode: 0, errorSummary: null });
    const done = s.get(id);
    expect(done?.status).toBe("success");
    expect(done?.finishedAt).not.toBeNull();
  });

  it("lists a project's runs from most recent to oldest", () => {
    const s = store();
    const a = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    const b = s.create({ projectSlug: "p", lane: "b", platform: null, params: {} });
    s.create({ projectSlug: "other", lane: "c", platform: null, params: {} });
    expect(s.listByProject("p").map((r) => r.id)).toEqual([b, a]);
  });

  it("marks any run still active as interrupted", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    s.markRunning(id, { branch: "main", commitSha: "x" });
    expect(s.interruptActive()).toBe(1);
    expect(s.get(id)?.status).toBe("interrupted");
    expect(s.interruptActive()).toBe(0);
  });

  it("records steps and artifacts attached to the run", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    s.replaceSteps(id, [
      { idx: 0, name: "match", durationMs: 1100, status: "success", logOffset: 42, source: "report" },
      { idx: 1, name: "build_app", durationMs: 90_000, status: "failed", logOffset: null, source: "report" },
    ]);
    s.addArtifact(id, { filename: "P.ipa", path: "/tmp/P.ipa", size: 10, kind: "ipa" });

    expect(s.steps(id)).toHaveLength(2);
    expect(s.steps(id)[1]!.status).toBe("failed");
    expect(s.artifacts(id)[0]!.kind).toBe("ipa");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/db/runs.test.ts`
Expected: failure — modules not found.

- [ ] **Step 3: Write the schema and the store**

`src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_slug  TEXT    NOT NULL,
  lane          TEXT    NOT NULL,
  platform      TEXT,
  params        TEXT    NOT NULL DEFAULT '{}',
  status        TEXT    NOT NULL,
  branch        TEXT,
  commit_sha    TEXT,
  trigger       TEXT    NOT NULL DEFAULT 'manual',
  interactive   INTEGER NOT NULL DEFAULT 0,
  queued_at     TEXT    NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  exit_code     INTEGER,
  error_summary TEXT
);
CREATE INDEX IF NOT EXISTS run_by_project ON run (project_slug, id DESC);

CREATE TABLE IF NOT EXISTS run_step (
  run_id      INTEGER NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  duration_ms INTEGER,
  status      TEXT    NOT NULL,
  log_offset  INTEGER,
  source      TEXT    NOT NULL,
  PRIMARY KEY (run_id, idx)
);

CREATE TABLE IF NOT EXISTS artifact (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   INTEGER NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  filename TEXT    NOT NULL,
  path     TEXT    NOT NULL,
  size     INTEGER NOT NULL,
  kind     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS introspection_cache (
  project_slug TEXT PRIMARY KEY,
  config_hash  TEXT NOT NULL,
  payload      TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);
```

`src/db/open.ts`:

```ts
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const here = dirname(fileURLToPath(import.meta.url));
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return db;
}
```

> The `schema.sql` file must be copied next to the compiled JS — the `build` script from Task 1
> already takes care of that. In development, `tsx` runs the sources: the path is correct with
> nothing extra to do.

`src/db/runs.ts`:

```ts
import type { Db } from "./open.js";

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "interrupted";

/** A run is active until it reaches a terminal state. */
const ACTIVE: RunStatus[] = ["queued", "preparing", "running"];

export interface Run {
  id: number;
  projectSlug: string;
  lane: string;
  platform: string | null;
  params: Record<string, string>;
  status: RunStatus;
  branch: string | null;
  commitSha: string | null;
  interactive: boolean;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorSummary: string | null;
}

export interface Step {
  idx: number;
  name: string;
  durationMs: number | null;
  status: string;
  logOffset: number | null;
  source: "report" | "live";
}

export interface Artifact {
  id: number;
  filename: string;
  path: string;
  size: number;
  kind: string;
}

interface RunRow {
  id: number;
  project_slug: string;
  lane: string;
  platform: string | null;
  params: string;
  status: RunStatus;
  branch: string | null;
  commit_sha: string | null;
  interactive: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error_summary: string | null;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  projectSlug: r.project_slug,
  lane: r.lane,
  platform: r.platform,
  params: JSON.parse(r.params) as Record<string, string>,
  status: r.status,
  branch: r.branch,
  commitSha: r.commit_sha,
  interactive: r.interactive === 1,
  queuedAt: r.queued_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  exitCode: r.exit_code,
  errorSummary: r.error_summary,
});

const now = () => new Date().toISOString();

export class RunStore {
  constructor(private readonly db: Db) {}

  create(input: {
    projectSlug: string;
    lane: string;
    platform: string | null;
    params: Record<string, string>;
    interactive?: boolean;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO run (project_slug, lane, platform, params, status, interactive, queued_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        input.projectSlug,
        input.lane,
        input.platform,
        JSON.stringify(input.params),
        input.interactive ? 1 : 0,
        now(),
      );
    return Number(res.lastInsertRowid);
  }

  get(id: number): Run | null {
    const row = this.db.prepare("SELECT * FROM run WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  listByProject(slug: string, limit = 50): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM run WHERE project_slug = ? ORDER BY id DESC LIMIT ?")
      .all(slug, limit) as RunRow[];
    return rows.map(toRun);
  }

  setStatus(id: number, status: RunStatus): void {
    this.db.prepare("UPDATE run SET status = ? WHERE id = ?").run(status, id);
  }

  markRunning(id: number, git: { branch: string; commitSha: string }): void {
    this.db
      .prepare("UPDATE run SET status = 'running', started_at = ?, branch = ?, commit_sha = ? WHERE id = ?")
      .run(now(), git.branch, git.commitSha, id);
  }

  finish(
    id: number,
    r: { status: RunStatus; exitCode: number | null; errorSummary: string | null },
  ): void {
    this.db
      .prepare("UPDATE run SET status = ?, finished_at = ?, exit_code = ?, error_summary = ? WHERE id = ?")
      .run(r.status, now(), r.exitCode, r.errorSummary, id);
  }

  /** At startup: no run can still be in progress, the process that carried it is dead. */
  interruptActive(): number {
    const placeholders = ACTIVE.map(() => "?").join(", ");
    const res = this.db
      .prepare(`UPDATE run SET status = 'interrupted', finished_at = ? WHERE status IN (${placeholders})`)
      .run(now(), ...ACTIVE);
    return res.changes;
  }

  replaceSteps(runId: number, steps: Step[]): void {
    const del = this.db.prepare("DELETE FROM run_step WHERE run_id = ?");
    const ins = this.db.prepare(
      `INSERT INTO run_step (run_id, idx, name, duration_ms, status, log_offset, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      del.run(runId);
      for (const s of steps) {
        ins.run(runId, s.idx, s.name, s.durationMs, s.status, s.logOffset, s.source);
      }
    })();
  }

  steps(runId: number): Step[] {
    const rows = this.db
      .prepare("SELECT * FROM run_step WHERE run_id = ? ORDER BY idx")
      .all(runId) as {
      idx: number;
      name: string;
      duration_ms: number | null;
      status: string;
      log_offset: number | null;
      source: "report" | "live";
    }[];
    return rows.map((r) => ({
      idx: r.idx,
      name: r.name,
      durationMs: r.duration_ms,
      status: r.status,
      logOffset: r.log_offset,
      source: r.source,
    }));
  }

  addArtifact(runId: number, a: Omit<Artifact, "id">): void {
    this.db
      .prepare("INSERT INTO artifact (run_id, filename, path, size, kind) VALUES (?, ?, ?, ?, ?)")
      .run(runId, a.filename, a.path, a.size, a.kind);
  }

  artifacts(runId: number): Artifact[] {
    return this.db
      .prepare("SELECT id, filename, path, size, kind FROM artifact WHERE run_id = ? ORDER BY filename")
      .all(runId) as Artifact[];
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/db/runs.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/db tests/db
git commit -m "feat(db): SQLite schema and run store"
```

---

### Task 5: Git workspace management

**Files:**
- Create: `src/git/workspace.ts`, `tests/fixtures/repos.ts`, `tests/git/workspace.test.ts`

- [ ] **Step 1: Write the test helper and the failing tests**

`tests/fixtures/repos.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Creates a local git repository serving as a "remote" in the tests. */
export async function makeOriginRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "laneyard-origin-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Test"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    await run("mkdir", ["-p", join(dir, name, "..")]).catch(() => {});
    await writeFile(join(dir, name), content, "utf8");
  }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

export async function commitTo(repo: string, name: string, content: string): Promise<string> {
  await writeFile(join(repo, name), content, "utf8");
  await run("git", ["add", "-A"], { cwd: repo });
  await run("git", ["commit", "-q", "-m", `edit ${name}`], { cwd: repo });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repo });
  return stdout.trim();
}

export async function tmpDir(prefix = "laneyard-ws-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
```

`tests/git/workspace.test.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../../src/git/workspace.js";
import { commitTo, makeOriginRepo, tmpDir } from "../fixtures/repos.js";

describe("Workspace", () => {
  it("clones on first access then declares itself ready", async () => {
    const origin = await makeOriginRepo({ "README.md": "hello" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);

    expect(await ws.exists()).toBe(false);
    await ws.prepare("main");
    expect(await ws.exists()).toBe(true);
    expect(await readFile(join(ws.path, "README.md"), "utf8")).toBe("hello");
  });

  it("fetches new commits on the next run", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");

    const sha = await commitTo(origin, "a.txt", "v2");
    await ws.prepare("main");

    expect(await readFile(join(ws.path, "a.txt"), "utf8")).toBe("v2");
    expect(await ws.headSha()).toBe(sha);
  });

  it("refuses to prepare over uncommitted changes", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");
    await writeFile(join(ws.path, "a.txt"), "edited by hand", "utf8");

    expect(await ws.isDirty()).toBe(true);
    await expect(ws.prepare("main")).rejects.toThrow(/uncommitted/i);
  });

  it("fails readably on an unknown branch", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await expect(ws.prepare("does-not-exist")).rejects.toThrow(/does-not-exist/);
  });

  it("clones on demand without switching branch", async () => {
    const origin = await makeOriginRepo({ "laneyard.yml": "runtime: system\n" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);

    await ws.ensureCloned();
    expect(await ws.exists()).toBe(true);

    // Idempotent: a second call redoes nothing and doesn't throw.
    await ws.ensureCloned();
    expect(await ws.exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/git/workspace.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the workspace**

`src/git/workspace.ts`:

```ts
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitAuth {
  kind: "none" | "ssh_key" | "token";
  ref?: string;
}

/**
 * A clone managed by Laneyard, kept between runs.
 * All git commands go through here to share the authentication environment.
 */
export class Workspace {
  constructor(
    readonly path: string,
    private readonly gitUrl: string,
    private readonly auth: GitAuth = { kind: "none" },
  ) {}

  private env(): NodeJS.ProcessEnv {
    // Without this, git can block on a credentials prompt and freeze the run.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (this.auth.kind === "ssh_key" && this.auth.ref) {
      env["GIT_SSH_COMMAND"] = `ssh -i ${this.auth.ref} -o IdentitiesOnly=yes -o BatchMode=yes`;
    }
    return env;
  }

  private async git(args: string[], cwd = this.path): Promise<string> {
    try {
      const { stdout } = await exec("git", args, { cwd, env: this.env(), maxBuffer: 32 * 1024 * 1024 });
      return stdout.trim();
    } catch (cause) {
      const err = cause as { stderr?: string; message: string };
      throw new Error(`git ${args.join(" ")} failed: ${(err.stderr || err.message).trim()}`);
    }
  }

  async exists(): Promise<boolean> {
    try {
      await access(join(this.path, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True if there are uncommitted changes to *tracked* files.
   *
   * Untracked files are deliberately ignored: a build scatters them around
   * (fastlane rewrites `fastlane/README.md` on every run, artifacts land in
   * `build/`), and above all `git checkout` doesn't destroy them. Counting
   * them would make every second run impossible without protecting anything.
   */
  async isDirty(): Promise<boolean> {
    if (!(await this.exists())) return false;
    return (await this.git(["status", "--porcelain", "--untracked-files=no"])) !== "";
  }

  async headSha(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  /**
   * Guarantees the clone is present, without touching the current branch.
   *
   * Needed before any read of the repository outside a run — listing lanes,
   * reading laneyard.yml — since that information lives in the project's files.
   */
  async ensureCloned(onProgress?: (line: string) => void): Promise<void> {
    if (await this.exists()) return;
    onProgress?.(`Cloning ${this.gitUrl}…`);
    await this.git(["clone", this.gitUrl, this.path], process.cwd());
  }

  /**
   * Brings the workspace to the requested branch, up to date.
   * Clones on the first call, just fetches afterwards.
   */
  async prepare(branch: string, onProgress?: (line: string) => void): Promise<string> {
    if (!(await this.exists())) {
      await this.ensureCloned(onProgress);
    } else {
      if (await this.isDirty()) {
        throw new Error(
          "The workspace has uncommitted changes. " +
            "Commit them or clean the workspace before starting a run.",
        );
      }
      onProgress?.("Fetching updates…");
      await this.git(["fetch", "--prune", "origin"]);
    }

    onProgress?.(`Switching to ${branch}…`);
    await this.git(["checkout", "-q", "-B", branch, `origin/${branch}`]);
    return this.headSha();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/git/workspace.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/git tests/git tests/fixtures/repos.ts
git commit -m "feat(git): workspace clone, fetch, and checkout"
```

---

### Task 6: Ruby sidecar — the `lanes` command

**Files:**
- Create: `src/sidecar/ruby-env.ts`, `tests/sidecar/ruby-env.test.ts`, `ruby/introspect.rb`, `tests/ruby/introspect.test.ts`

#### Why a Ruby environment resolver

The sidecar assumes `require "fastlane"` works. That's only true if fastlane is a gem visible to
the current Ruby. But the most common install on macOS, Homebrew's, puts fastlane in a private
`GEM_HOME` and provides a launcher that sets it before running:

```bash
GEM_HOME="${HOME}/.local/share/fastlane/4.0.0" exec ".../libexec/bin/fastlane" "$@"
```

With this kind of install, `ruby -e 'require "fastlane"'` fails. `system` mode would therefore be
unusable with nothing to explain why. In `bundle` mode, `bundle exec` settles the question on its
own — the problem only concerns `system`.

Resolution proceeds by trial, from the simplest to the most specific, and the result is memoized:

1. the current environment, which is enough as soon as fastlane is installed normally
   (`gem install`, rbenv, rvm, asdf);
2. failing that, the environment extracted from the `fastlane` launcher if it's a shell script —
   the Homebrew case;
3. otherwise, an explicit failure saying what to do.

- [ ] **Step 1: Write the resolver's tests**

`tests/sidecar/ruby-env.test.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveRubyEnv } from "../../src/sidecar/ruby-env.js";

const exec = promisify(execFile);

describe("resolveRubyEnv", () => {
  it("returns an environment where Ruby can load fastlane", async () => {
    const resolved = await resolveRubyEnv();
    expect(resolved).not.toBeNull();

    const { stdout } = await exec("ruby", ["-e", 'require "fastlane"; print "ok"'], {
      env: resolved!.env,
      timeout: 180_000,
    });
    expect(stdout).toBe("ok");
  }, 240_000);

  it("indicates where the chosen environment comes from", async () => {
    const resolved = await resolveRubyEnv();
    expect(["process", "launcher"]).toContain(resolved!.source);
  }, 240_000);

  it("memoizes the result rather than probing again on every call", async () => {
    const a = await resolveRubyEnv();
    const b = await resolveRubyEnv();
    expect(b).toBe(a);
  }, 240_000);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/sidecar/ruby-env.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the resolver**

`src/sidecar/ruby-env.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RubyEnv {
  env: NodeJS.ProcessEnv;
  /** `process`: Ruby already knew. `launcher`: environment recovered from the fastlane launcher. */
  source: "process" | "launcher";
}

async function canRequireFastlane(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await exec("ruby", ["-e", 'require "fastlane"'], { env, timeout: 180_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconstructs the `fastlane` launcher's environment when it's a shell script.
 *
 * We don't run the launcher: we read back its `GEM_HOME` and `GEM_PATH`
 * assignments and have bash evaluate them, since it knows how to expand
 * `${HOME}` and default values. Deliberately narrow approach — two
 * variables, nothing else.
 */
async function envFromLauncher(): Promise<NodeJS.ProcessEnv | null> {
  const script = `
    shim=$(command -v fastlane) || exit 1
    head -c 2 "$shim" | grep -q '#!' || exit 1
    eval "$(grep -oE '(GEM_HOME|GEM_PATH)="[^"]*"' "$shim" | sed 's/^/export /')" || exit 1
    [ -n "$GEM_HOME" ] || exit 1
    printf '%s\\n%s\\n' "$GEM_HOME" "$GEM_PATH"
  `;
  try {
    const { stdout } = await exec("bash", ["-c", script], { timeout: 30_000 });
    const [gemHome, gemPath] = stdout.split("\n");
    if (!gemHome) return null;
    return { ...process.env, GEM_HOME: gemHome, GEM_PATH: gemPath || gemHome };
  } catch {
    return null;
  }
}

let cached: Promise<RubyEnv | null> | null = null;

/**
 * Finds an environment in which `ruby` can load fastlane, or null.
 *
 * The result is memoized: probing costs several seconds, since fastlane is
 * slow to load, and the install doesn't change while the process runs.
 */
export function resolveRubyEnv(): Promise<RubyEnv | null> {
  cached ??= (async () => {
    if (await canRequireFastlane(process.env)) {
      return { env: process.env, source: "process" as const };
    }
    const env = await envFromLauncher();
    if (env && (await canRequireFastlane(env))) {
      return { env, source: "launcher" as const };
    }
    return null;
  })();
  return cached;
}

/** Single message, so the problem isn't described differently in each place. */
export const FASTLANE_UNAVAILABLE =
  "Ruby cannot load fastlane. Install it for the current Ruby " +
  "(`gem install fastlane`), or declare a Gemfile in the project and set " +
  "the `runtime` setting to `bundle`.";
```

- [ ] **Step 4: Run the resolver's tests**

Run: `npm test -- tests/sidecar/ruby-env.test.ts`
Expected: 3 tests passing. The first call takes several seconds — fastlane is slow to load.

- [ ] **Step 5: Write the sidecar's tests**

`tests/ruby/introspect.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveRubyEnv } from "../../src/sidecar/ruby-env.js";
import { tmpDir } from "../fixtures/repos.js";

const exec = promisify(execFile);
const SCRIPT = join(process.cwd(), "ruby", "introspect.rb");

async function projectWithFastfile(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-fl-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  await writeFile(join(dir, "fastlane", "Fastfile"), content, "utf8");
  return dir;
}

async function introspect(dir: string, cmd: string): Promise<unknown> {
  // The sidecar runs here without bundle: it needs the resolved environment.
  const ruby = await resolveRubyEnv();
  if (!ruby) throw new Error("fastlane not found for the current Ruby");

  const { stdout } = await exec("ruby", [SCRIPT, cmd, "--fastlane-dir", "fastlane"], {
    cwd: dir,
    env: ruby.env,
    timeout: 180_000,
  });
  return JSON.parse(stdout);
}

describe("introspect.rb lanes", () => {
  it("lists lanes with platform and description", async () => {
    const dir = await projectWithFastfile(`
      platform :ios do
        desc "Push a new beta build to TestFlight"
        lane :beta do
          increment_build_number
        end

        private_lane :helper do
        end
      end

      lane :global do
      end
    `);

    const res = (await introspect(dir, "lanes")) as {
      ok: boolean;
      lanes: { name: string; platform: string | null; description: string; private: boolean }[];
    };

    expect(res.ok).toBe(true);
    const beta = res.lanes.find((l) => l.name === "beta");
    expect(beta).toBeDefined();
    expect(beta!.platform).toBe("ios");
    expect(beta!.description).toBe("Push a new beta build to TestFlight");
    expect(res.lanes.find((l) => l.name === "global")?.platform).toBeNull();
    expect(res.lanes.find((l) => l.name === "helper")?.private).toBe(true);
  }, 180_000);

  it("returns a structured error on an invalid Fastfile", async () => {
    const dir = await projectWithFastfile("lane :beta do\n  # never closed\n");
    const res = (await introspect(dir, "lanes")) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error.length).toBeGreaterThan(0);
  }, 180_000);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npm test -- tests/ruby/introspect.test.ts`
Expected: failure — `ruby/introspect.rb` doesn't exist.

- [ ] **Step 3: Write the sidecar**

`ruby/introspect.rb`:

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Laneyard's introspection sidecar.
#
# Launched in a project's folder — ideally via `bundle exec` — it's the only
# component that knows fastlane. It never writes anything: it reads and returns
# JSON on standard output.
#
#   ruby introspect.rb lanes   --fastlane-dir fastlane
#   ruby introspect.rb actions --fastlane-dir fastlane
#   ruby introspect.rb parse   --fastlane-dir fastlane
#
# The output contract is constant: { "ok": true, ... } or { "ok": false, "error": "..." }.
# An error is a valid response, never a trace on stderr.

require "json"

# See below: the real standard output is set aside right from the start so
# that nothing but our JSON can slip into it.
REAL_STDOUT = $stdout.dup

def respond(payload)
  REAL_STDOUT.puts JSON.generate(payload)
  REAL_STDOUT.flush
  exit 0
end

def fail_with(message)
  respond({ ok: false, error: message.to_s })
end

command = ARGV[0]
dir_index = ARGV.index("--fastlane-dir")
fastlane_dir = dir_index ? ARGV[dir_index + 1] : "fastlane"
fastfile_path = File.join(Dir.pwd, fastlane_dir, "Fastfile")

fail_with("Fastfile not found: #{fastfile_path}") unless File.exist?(fastfile_path)

# fastlane readily writes to standard output — plugin warnings, deprecation
# messages, update banner. Just one of these messages would corrupt the JSON
# the caller expects. Everything therefore goes to standard error, and only
# `respond` writes to the real output.
$stdout = $stderr

begin
  require "fastlane"
rescue LoadError => e
  fail_with("fastlane is not available in this Ruby environment (#{e.message})")
end

def collect_lanes(fastfile_path)
  ff = Fastlane::FastFile.new(fastfile_path)
  lanes = []
  ff.runner.lanes.each do |platform, platform_lanes|
    platform_lanes.each do |name, lane|
      lanes << {
        name: name.to_s,
        platform: platform&.to_s,
        description: Array(lane.description).join(" ").strip,
        private: lane.is_private
      }
    end
  end
  lanes
end

case command
when "lanes"
  begin
    lanes = collect_lanes(fastfile_path)
  rescue Exception => e # rubocop:disable Lint/RescueException
    # A Fastfile is arbitrary Ruby: loading it can raise anything at all,
    # including syntax errors that don't descend from StandardError.
    fail_with("Could not load the Fastfile: #{e.message}")
  end

  # `respond` ends with `exit`, which raises SystemExit — itself an Exception.
  # Calling it inside the protected block would catch its own exit and
  # write a second "exit" error JSON. It therefore stays outside.
  respond({ ok: true, lanes: lanes })
else
  fail_with("Unknown command: #{command.inspect}")
end
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/ruby/introspect.test.ts`
Expected: 2 tests passing. The first call is slow — fastlane takes several seconds to load,
hence the 180s timeout.

- [ ] **Step 5: Commit**

```bash
git add ruby tests/ruby src/sidecar tests/sidecar
git commit -m "feat(sidecar): lanes command for the Ruby introspection script"
```

---

### Task 7: TypeScript bridge to the sidecar, with caching

**Files:**
- Create: `src/sidecar/bridge.ts`, `src/db/cache.ts`, `src/sidecar/lanes.ts`, `tests/sidecar/lanes.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/sidecar/lanes.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheStore } from "../../src/db/cache.js";
import { openDatabase } from "../../src/db/open.js";
import { LaneReader } from "../../src/sidecar/lanes.js";
import { tmpDir } from "../fixtures/repos.js";

async function fastlaneDir(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("laneyard-lanes-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, "fastlane", name), content, "utf8");
  }
  return dir;
}

const LANES = [{ name: "beta", platform: "ios", description: "", private: false }];

describe("LaneReader", () => {
  it("queries the sidecar then serves the cache on the second call", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: LANES });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    expect(await reader.read("p", dir, "fastlane")).toEqual(LANES);
    expect(await reader.read("p", dir, "fastlane")).toEqual(LANES);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-queries the sidecar when a file in the folder changes", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: LANES });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    await reader.read("p", dir, "fastlane");
    await writeFile(join(dir, "fastlane", "Fastfile"), "lane :beta do\n  puts 1\nend\n", "utf8");
    await reader.read("p", dir, "fastlane");

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("also re-queries when a neighbouring file changes, not just the Fastfile", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n", Appfile: "app_identifier 'a'\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: LANES });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    await reader.read("p", dir, "fastlane");
    await writeFile(join(dir, "fastlane", "Appfile"), "app_identifier 'b'\n", "utf8");
    await reader.read("p", dir, "fastlane");

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("propagates the sidecar's error without caching anything", async () => {
    const dir = await fastlaneDir({ Fastfile: "broken" });
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: "unreadable Fastfile" });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    await expect(reader.read("p", dir, "fastlane")).rejects.toThrow(/unreadable/);
    await expect(reader.read("p", dir, "fastlane")).rejects.toThrow(/unreadable/);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/sidecar/lanes.test.ts`
Expected: failure — modules not found.

- [ ] **Step 3: Implement the bridge, the cache, and the reader**

`src/sidecar/bridge.ts`:

```ts
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FASTLANE_UNAVAILABLE, resolveRubyEnv } from "./ruby-env.js";

const exec = promisify(execFile);

export type SidecarResponse =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ruby", "introspect.rb");

export type Invoke = (
  command: string,
  cwd: string,
  fastlaneDir: string,
) => Promise<SidecarResponse>;

/**
 * Runs the sidecar in the project's context.
 * In `bundle` mode, the invocation goes through `bundle exec` to see the
 * right version of fastlane and the plugins the project declares.
 */
export function makeInvoke(runtime: "bundle" | "system"): Invoke {
  return async (command, cwd, fastlaneDir) => {
    const [bin, args] =
      runtime === "bundle"
        ? ["bundle", ["exec", "ruby", SCRIPT, command, "--fastlane-dir", fastlaneDir]]
        : ["ruby", [SCRIPT, command, "--fastlane-dir", fastlaneDir]];

    // In bundle mode, `bundle exec` already provides the right environment. In
    // system mode, it has to be found: depending on the install, `ruby` may not see fastlane.
    let env = process.env;
    if (runtime === "system") {
      const ruby = await resolveRubyEnv();
      if (!ruby) return { ok: false, error: FASTLANE_UNAVAILABLE };
      env = ruby.env;
    }

    try {
      const { stdout } = await exec(bin, args as string[], {
        cwd,
        env,
        timeout: 180_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(stdout) as SidecarResponse;
    } catch (cause) {
      const err = cause as { stderr?: string; message: string };
      return {
        ok: false,
        error: `The Ruby sidecar failed: ${(err.stderr || err.message).trim()}`,
      };
    }
  };
}
```

`src/db/cache.ts`:

```ts
import type { Db } from "./open.js";

export class CacheStore {
  constructor(private readonly db: Db) {}

  get(slug: string, hash: string): unknown | null {
    const row = this.db
      .prepare("SELECT payload FROM introspection_cache WHERE project_slug = ? AND config_hash = ?")
      .get(slug, hash) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }

  put(slug: string, hash: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO introspection_cache (project_slug, config_hash, payload, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (project_slug) DO UPDATE
           SET config_hash = excluded.config_hash,
               payload = excluded.payload,
               fetched_at = excluded.fetched_at`,
      )
      .run(slug, hash, JSON.stringify(payload), new Date().toISOString());
  }
}
```

`src/sidecar/lanes.ts`:

```ts
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheStore } from "../db/cache.js";
import type { Invoke } from "./bridge.js";

export interface Lane {
  name: string;
  platform: string | null;
  description: string;
  private: boolean;
}

/**
 * Hash of the whole fastlane folder, not just the Fastfile:
 * an Appfile, a Pluginfile, or an imported file change the lanes just as much.
 */
async function hashFastlaneDir(root: string, fastlaneDir: string): Promise<string> {
  const dir = join(root, fastlaneDir);
  const hash = createHash("sha256");
  const entries = (await readdir(dir, { withFileTypes: true, recursive: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();

  for (const file of entries) {
    hash.update(file);
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

export class LaneReader {
  constructor(
    private readonly cache: CacheStore,
    private readonly invoke: Invoke,
  ) {}

  async read(slug: string, workspacePath: string, fastlaneDir: string): Promise<Lane[]> {
    const hash = await hashFastlaneDir(workspacePath, fastlaneDir);

    const cached = this.cache.get(slug, hash);
    if (cached) return cached as Lane[];

    const res = await this.invoke("lanes", workspacePath, fastlaneDir);
    if (!res.ok) throw new Error(res.error);

    const lanes = res["lanes"] as Lane[];
    this.cache.put(slug, hash, lanes);
    return lanes;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/sidecar/lanes.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/sidecar src/db/cache.ts tests/sidecar
git commit -m "feat(sidecar): TypeScript bridge and introspection cache"
```

---

### Task 8: Log store

**Files:**
- Create: `src/logs/store.ts`, `tests/logs/store.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/logs/store.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LogStore } from "../../src/logs/store.js";
import { tmpDir } from "../fixtures/repos.js";

describe("LogStore", () => {
  it("writes and reads back in full", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(1);
    await w.append("first line\n");
    await w.append("second line\n");
    await w.close();

    expect(await store.read(1)).toBe("first line\nsecond line\n");
  });

  it("reads back from a byte offset", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(2);
    await w.append("abcdef");
    await w.close();

    expect(await store.read(2, 3)).toBe("def");
  });

  it("exposes the current offset after every write", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(3);
    expect(w.offset).toBe(0);
    await w.append("hüllo"); // 6 bytes in UTF-8, not 5
    expect(w.offset).toBe(6);
    await w.close();
  });

  it("returns an empty string for a run with no log", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    expect(await store.read(999)).toBe("");
  });

  it("places the file in the configured folder", async () => {
    const dir = await tmpDir("laneyard-logs-");
    const store = new LogStore(dir);
    expect(store.pathFor(7)).toBe(join(dir, "7.log"));
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/logs/store.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the store**

`src/logs/store.ts`:

```ts
import { createReadStream } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * Append-only writer for a run.
 * `offset` counts bytes, never characters: that's what the browser-side
 * read resumption works with, and a multi-byte character can span several bytes.
 */
export class LogWriter {
  private _offset = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly handle: FileHandle) {}

  get offset(): number {
    return this._offset;
  }

  /**
   * Reserves the offset immediately then serializes the writes.
   *
   * Fragments arrive from a PTY, without waiting: if the offset were computed
   * after the write, two concurrent fragments could claim the same position
   * and the browser-side catch-up would duplicate or lose text.
   */
  async append(chunk: string): Promise<number> {
    const buf = Buffer.from(chunk, "utf8");
    const start = this._offset;
    this._offset += buf.byteLength;

    this.queue = this.queue.then(() => this.handle.write(buf)).catch(() => {
      // The file may have been closed while the process was still finishing up.
    });
    await this.queue;
    return start;
  }

  async close(): Promise<void> {
    await this.queue;
    await this.handle.close();
  }
}

export class LogStore {
  constructor(private readonly dir: string) {}

  pathFor(runId: number): string {
    return join(this.dir, `${runId}.log`);
  }

  async open(runId: number): Promise<LogWriter> {
    await mkdir(this.dir, { recursive: true });
    return new LogWriter(await open(this.pathFor(runId), "w"));
  }

  async read(runId: number, fromOffset = 0): Promise<string> {
    try {
      const buf = await readFile(this.pathFor(runId));
      return buf.subarray(fromOffset).toString("utf8");
    } catch {
      return "";
    }
  }

  /** For serving a large log without loading it entirely into memory. */
  stream(runId: number, fromOffset = 0): NodeJS.ReadableStream {
    return createReadStream(this.pathFor(runId), { start: fromOffset });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/logs/store.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/logs tests/logs
git commit -m "feat(logs): append-only writing and reading from an offset"
```

---

### Task 9: Detecting live steps and reading report.xml

**Files:**
- Create: `src/runner/live-steps.ts`, `src/runner/report.ts`, `tests/runner/live-steps.test.ts`, `tests/runner/report.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/runner/live-steps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LiveStepTracker } from "../../src/runner/live-steps.js";

describe("LiveStepTracker", () => {
  it("spots a step and keeps its offset", () => {
    const t = new LiveStepTracker();
    t.consume("[09:41:02]: noise before\n", 0);
    t.consume("[09:41:03]: ------ Step: build_app ------\n", 30);
    expect(t.steps()).toEqual([{ name: "build_app", logOffset: 30 }]);
  });

  it("spots several steps in order of appearance", () => {
    const t = new LiveStepTracker();
    t.consume("[t]: --- Step: match ---\n[t]: --- Step: build_app ---\n", 100);
    expect(t.steps().map((s) => s.name)).toEqual(["match", "build_app"]);
    expect(t.steps()[0]!.logOffset).toBe(100);
    expect(t.steps()[1]!.logOffset).toBeGreaterThan(100);
  });

  it("rejoins a line split across two fragments", () => {
    const t = new LiveStepTracker();
    t.consume("[t]: ------ Step: buil", 0);
    t.consume("d_app ------\n", 17);
    expect(t.steps().map((s) => s.name)).toEqual(["build_app"]);
  });

  it("ignores a line that mentions Step without being a separator", () => {
    const t = new LiveStepTracker();
    t.consume("The word Step: appears here with no dashes\n", 0);
    expect(t.steps()).toEqual([]);
  });
});
```

`tests/runner/report.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readReport } from "../../src/runner/report.js";
import { tmpDir } from "../fixtures/repos.js";

// Real form observed: successful actions are self-closing.
const OK = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="fastlane.lanes">
    <testcase classname="fastlane.lanes" name="0: match" time="11.5"/>
    <testcase classname="fastlane.lanes" name="1: build_app" time="238.25"/>
  </testsuite>
</testsuites>`;

// Mixed report: this is the case that traps a badly ordered pattern.
const FAILED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="fastlane.lanes">
    <testcase classname="fastlane.lanes" name="0: match" time="1.0"/>
    <testcase classname="fastlane.lanes" name="1: build_app" time="12.0">
      <failure message="Error building the application"></failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe("readReport", () => {
  it("extracts name, index, and duration for each action", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), OK, "utf8");
    const steps = await readReport(join(dir, "report.xml"));

    expect(steps).toEqual([
      { idx: 0, name: "match", durationMs: 11_500, status: "success" },
      { idx: 1, name: "build_app", durationMs: 238_250, status: "success" },
    ]);
  });

  it("attributes the failure only to the action concerned in a mixed report", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), FAILED, "utf8");
    const steps = await readReport(join(dir, "report.xml"));
    // Narrows the type as much as it verifies: the rest of the test indexes the array.
    if (!steps) throw new Error("expected report");

    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe("success");
    expect(steps[1]!.name).toBe("build_app");
    expect(steps[1]!.status).toBe("failed");
  });

  it("returns null if the report doesn't exist", async () => {
    const dir = await tmpDir("laneyard-rep-");
    expect(await readReport(join(dir, "report.xml"))).toBeNull();
  });

  it("returns null on an unreadable report rather than throwing", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), "<testsuites", "utf8");
    expect(await readReport(join(dir, "report.xml"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/runner/`
Expected: failure — modules not found.

- [ ] **Step 3: Implement the two readers**

`src/runner/live-steps.ts`:

```ts
/**
 * Spotting of step separators in fastlane's output, during the run.
 *
 * Fragile by nature: this is text meant for humans. We therefore keep only
 * one thing from it, the byte offset where each step starts — the only
 * piece of information report.xml doesn't contain. The names and durations
 * that count come from the report at the end of the run.
 */
// Real form observed, ANSI sequences included:
//   [13:14:00]: \x1b[32m--- Step: mkdir -p ../build && echo x > y.ipa ---\x1b[0m
// The name isn't an identifier: for a `sh` action, it's the entire command,
// spaces included. The capture is therefore lazy up to the closing dashes,
// and definitely not `\S+`.
const SEPARATOR = /-{2,}\s+Step:\s*(.+?)\s+-{2,}/;

export interface LiveStep {
  name: string;
  logOffset: number;
}

export class LiveStepTracker {
  private pending = "";
  private pendingOffset = 0;
  private found: LiveStep[] = [];

  /** `offset` is the fragment's position in the log file. */
  consume(chunk: string, offset: number): void {
    if (this.pending === "") this.pendingOffset = offset;
    this.pending += chunk;

    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl);
      const lineOffset = this.pendingOffset;

      this.pendingOffset += Buffer.byteLength(this.pending.slice(0, nl + 1), "utf8");
      this.pending = this.pending.slice(nl + 1);

      const m = SEPARATOR.exec(line);
      if (m?.[1]) this.found.push({ name: m[1], logOffset: lineOffset });
    }
  }

  steps(): LiveStep[] {
    return this.found;
  }
}
```

`src/runner/report.ts`:

```ts
import { readFile } from "node:fs/promises";

export interface ReportStep {
  idx: number;
  name: string;
  durationMs: number | null;
  status: "success" | "failed";
}

// The self-closing branch comes first: fastlane writes successful actions
// as `<testcase … />` and only failed ones have a body. In the other order,
// `[^>]*` would swallow the final `/` and the lazy body would run up to the
// next `</testcase>`, merging two actions and blaming the failure on the wrong one.
const TESTCASE = /<testcase\b([^>]*?)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
// `\b` is mandatory: without it, searching for `name=` first finds the end
// of `classname=`, which fastlane systematically writes as the first attribute.
/**
 * Decodes the XML entities of an attribute value.
 *
 * Essential: a `sh` action's name contains the entire command, so it
 * readily includes a `&&` or a redirection, which the report writes as
 * `&amp;&amp;` and `&gt;`. Without decoding, the interface would display the escaping.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decodeXml = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code] ?? whole;
  });

const ATTR = (source: string, name: string): string | null => {
  const raw = new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1];
  return raw === undefined ? null : decodeXml(raw);
};

/**
 * Reads the JUnit report that fastlane writes on every run.
 * It's the authoritative source for names, order, durations, and failures.
 *
 * Returns null if the report is missing or unreadable — the normal case for
 * a cancelled, timed-out, or interrupted run, or one that failed before even
 * reaching fastlane.
 */
export async function readReport(path: string): Promise<ReportStep[] | null> {
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (!xml.includes("<testsuite")) return null;

  const steps: ReportStep[] = [];
  for (const m of xml.matchAll(TESTCASE)) {
    const attrs = m[1] ?? m[2] ?? "";
    const body = m[3] ?? "";
    const rawName = ATTR(attrs, "name");
    if (rawName === null) continue;

    // fastlane names its cases "<index>: <action>".
    const named = /^(\d+):\s*(.+)$/.exec(rawName);
    const time = ATTR(attrs, "time");

    steps.push({
      idx: named ? Number(named[1]) : steps.length,
      name: named ? named[2]!.trim() : rawName.trim(),
      durationMs: time === null ? null : Math.round(Number(time) * 1000),
      status: body.includes("<failure") ? "failed" : "success",
    });
  }

  return steps.length > 0 ? steps.sort((a, b) => a.idx - b.idx) : null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/runner/`
Expected: 8 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/runner tests/runner
git commit -m "feat(runner): live step detection and report.xml reading"
```

---

### Task 10: Artifact collection

**Files:**
- Create: `src/runner/artifacts.ts`, `tests/runner/artifacts.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/runner/artifacts.test.ts`:

```ts
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifacts, guessKind } from "../../src/runner/artifacts.js";
import { tmpDir } from "../fixtures/repos.js";

async function workspaceWith(files: string[]): Promise<string> {
  const dir = await tmpDir("laneyard-art-");
  for (const f of files) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), "content", "utf8");
  }
  return dir;
}

describe("guessKind", () => {
  it("recognizes the common types", () => {
    expect(guessKind("Sample.ipa")).toBe("ipa");
    expect(guessKind("app-release.aab")).toBe("aab");
    expect(guessKind("app.apk")).toBe("apk");
    expect(guessKind("Sample.app.dSYM.zip")).toBe("dsym");
    expect(guessKind("notes.txt")).toBe("other");
  });
});

describe("collectArtifacts", () => {
  it("moves files matching the patterns out of the workspace", async () => {
    const ws = await workspaceWith(["build/Sample.ipa", "build/notes.txt"]);
    const dest = await tmpDir("laneyard-dest-");

    const found = await collectArtifacts(ws, ["build/**/*.ipa"], dest);

    expect(found).toHaveLength(1);
    expect(found[0]!.filename).toBe("Sample.ipa");
    expect(found[0]!.kind).toBe("ipa");
    expect(found[0]!.size).toBeGreaterThan(0);
    expect(await readdir(dest)).toEqual(["Sample.ipa"]);
  });

  it("returns nothing when no pattern is configured", async () => {
    const ws = await workspaceWith(["build/Sample.ipa"]);
    expect(await collectArtifacts(ws, [], await tmpDir())).toEqual([]);
  });

  it("disambiguates two files with the same name", async () => {
    const ws = await workspaceWith(["a/app.apk", "b/app.apk"]);
    const dest = await tmpDir("laneyard-dest-");

    const found = await collectArtifacts(ws, ["**/*.apk"], dest);

    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.filename)).size).toBe(2);
  });

  it("ignores a pattern that matches nothing without failing", async () => {
    const ws = await workspaceWith(["build/Sample.ipa"]);
    expect(await collectArtifacts(ws, ["does-not-exist/**/*.zip"], await tmpDir())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/runner/artifacts.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the collection**

`src/runner/artifacts.ts`:

```ts
import { mkdir, rename, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { glob } from "tinyglobby";

export interface CollectedArtifact {
  filename: string;
  path: string;
  size: number;
  kind: string;
}

export function guessKind(filename: string): string {
  const name = filename.toLowerCase();
  if (name.endsWith(".dsym.zip") || name.includes(".dsym")) return "dsym";
  switch (extname(name)) {
    case ".ipa":
      return "ipa";
    case ".apk":
      return "apk";
    case ".aab":
      return "aab";
    default:
      return "other";
  }
}

/**
 * Moves out of the workspace any file matching the configured patterns.
 *
 * The patterns are the only contract: Laneyard doesn't parse the run's
 * output to guess paths. Moving — rather than copying — avoids doubling
 * disk usage and guarantees the next build won't accidentally reuse a
 * stale artifact.
 */
export async function collectArtifacts(
  workspacePath: string,
  patterns: string[],
  destDir: string,
): Promise<CollectedArtifact[]> {
  if (patterns.length === 0) return [];

  const matches = await glob(patterns, {
    cwd: workspacePath,
    absolute: true,
    onlyFiles: true,
    dot: false,
  });
  if (matches.length === 0) return [];

  await mkdir(destDir, { recursive: true });

  const used = new Set<string>();
  const collected: CollectedArtifact[] = [];

  for (const source of matches.sort()) {
    let filename = basename(source);
    if (used.has(filename)) {
      // Two paths can produce the same name; we prefix rather than overwrite.
      const ext = extname(filename);
      const stem = filename.slice(0, filename.length - ext.length);
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n += 1;
      filename = `${stem}-${n}${ext}`;
    }
    used.add(filename);

    const dest = join(destDir, filename);
    await rename(source, dest);
    const info = await stat(dest);

    collected.push({ filename, path: dest, size: info.size, kind: guessKind(filename) });
  }

  return collected;
}
```

> `rename` fails across two different filesystems (`EXDEV`). The workspace and the artifacts
> folder both live under `~/.laneyard/`, so the case doesn't arise here. Should they ever
> diverge, replace with copy then delete.

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/runner/artifacts.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/runner/artifacts.ts tests/runner/artifacts.test.ts
git commit -m "feat(runner): artifact collection by patterns"
```

---

### Task 11: Execution inside a pseudo-terminal

**Files:**
- Create: `src/runner/pty.ts`, `tests/fixtures/fake-fastlane/*`, `tests/runner/pty.test.ts`

- [ ] **Step 1: Create the fake fastlane and write the failing tests**

`tests/fixtures/fake-fastlane/fastlane` (make it executable: `chmod +x`):

```bash
#!/usr/bin/env bash
# Fake fastlane for the tests: replays a recorded output without building anything.
#
#   FAKE_FASTLANE_SCENARIO=success|failure|slow
#   FAKE_FASTLANE_REPORT_DIR=<folder to write report.xml to, default $PWD/fastlane>
#
# It mimics the real behaviour: step separators, a JUnit report written
# relative to the current folder, and the production of an artifact. No
# dependency on Xcode, so the test suite can run anywhere.
set -euo pipefail

scenario="${FAKE_FASTLANE_SCENARIO:-success}"
# Like real fastlane, the report is written into the project's fastlane folder.
report_dir="${FAKE_FASTLANE_REPORT_DIR:-$PWD/fastlane}"

echo "[09:41:01]: Driving the lane '$*'"
echo "[09:41:02]: ------ Step: match ------"
echo "[09:41:03]: Installing certificates"
echo "[09:41:04]: ------ Step: build_app ------"
echo "[09:41:05]: Compiling sources"

if [ "$scenario" = "slow" ]; then
  sleep 30
fi

# A build produces its artifact. The build/ folder is gitignored in the
# fixtures, which keeps a moved artifact from dirtying the workspace.
mkdir -p "$PWD/build"
echo "fake binary" > "$PWD/build/Sample.ipa"

write_report() {
  mkdir -p "$report_dir"
  cat > "$report_dir/report.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="fastlane.lanes">
    <testcase classname="fastlane.lanes" name="0: match" time="1.5"></testcase>
    <testcase classname="fastlane.lanes" name="1: build_app" time="2.5">$1</testcase>
  </testsuite>
</testsuites>
XML
}

if [ "$scenario" = "failure" ]; then
  echo "[09:41:09]: Error building the application"
  write_report '<failure message="Error building the application"></failure>'
  exit 1
fi

echo "[09:41:09]: fastlane.tools finished successfully"
write_report ""
exit 0
```

`tests/runner/pty.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInPty } from "../../src/runner/pty.js";
import { tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

describe("runInPty", () => {
  it("streams the output and returns a zero exit code on success", async () => {
    const chunks: string[] = [];
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "success" },
      onData: (c) => chunks.push(c),
    });

    expect(res.exitCode).toBe(0);
    expect(chunks.join("")).toContain("Step: build_app");
  });

  it("reports the exit code of a failure", async () => {
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "failure" },
      onData: () => {},
    });
    expect(res.exitCode).toBe(1);
  });

  it("kills the process past the allotted timeout", async () => {
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "slow" },
      onData: () => {},
      timeoutMs: 1000,
    });
    expect(res.timedOut).toBe(true);
    // Killed by signal: the code must reflect the violent death, not be 0.
    expect(res.exitCode).not.toBe(0);
    expect(res.signal).not.toBeNull();
  }, 20_000);

  it("fails cleanly if the command doesn't exist", async () => {
    const res = await runInPty({
      command: "nonexistent-command-xyz",
      args: [],
      cwd: await tmpDir(),
      env: { PATH: "/does-not-exist" },
      onData: () => {},
    });
    expect(res.exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `chmod +x tests/fixtures/fake-fastlane/fastlane && npm test -- tests/runner/pty.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the PTY launch**

`src/runner/pty.ts`:

```ts
import pty from "node-pty";

export interface PtyRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onData: (chunk: string) => void;
  timeoutMs?: number;
}

export interface PtyRunResult {
  exitCode: number;
  signal: number | null;
  timedOut: boolean;
}

export interface PtyHandle {
  write(input: string): void;
  kill(signal?: string): void;
}

/**
 * Runs a command in a pseudo-terminal.
 *
 * The PTY serves two purposes: fastlane believes it's in a real terminal and
 * keeps its usual display, and input remains possible if a run ever needs one.
 */
export function startPty(opts: PtyRunOptions): { handle: PtyHandle; done: Promise<PtyRunResult> } {
  let proc: pty.IPty;
  try {
    proc = pty.spawn(opts.command, opts.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.cwd,
      env: opts.env as Record<string, string>,
    });
  } catch (cause) {
    // Command not found: depending on the platform, node-pty throws or returns 127.
    // We normalize so the caller only has one case to handle.
    opts.onData(`\nCould not launch: ${(cause as Error).message}\n`);
    return {
      handle: { write: () => {}, kill: () => {} },
      done: Promise.resolve({ exitCode: 127, signal: null, timedOut: false }),
    };
  }

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  proc.onData(opts.onData);

  const done = new Promise<PtyRunResult>((resolve) => {
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        // SIGINT first: fastlane cleans up after itself. SIGKILL if it keeps stalling.
        try {
          proc.kill("SIGINT");
        } catch {
          /* the process may have died in the meantime */
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* same */
          }
        }, 5000);
      }, opts.timeoutMs);
    }

    proc.onExit(({ exitCode, signal }) => {
      if (timer) clearTimeout(timer);
      // `waitpid` only reports an exit code for a normal end: a process
      // killed by a signal leaves 0, which would pass a cancellation off
      // as a success. We apply the shell convention, 128 + signal, so an
      // exit code always stays interpretable.
      const killed = signal !== undefined && signal !== 0;
      resolve({
        exitCode: killed && exitCode === 0 ? 128 + signal : exitCode,
        signal: signal ?? null,
        timedOut,
      });
    });
  });

  const handle: PtyHandle = {
    write: (input) => proc.write(input),
    kill: (signal = "SIGINT") => {
      try {
        proc.kill(signal);
      } catch {
        /* already finished */
      }
    },
  };

  return { handle, done };
}

/** Blocking variant, handy for tests and short commands. */
export async function runInPty(opts: PtyRunOptions): Promise<PtyRunResult> {
  return startPty(opts).done;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/runner/pty.test.ts`
Expected: 4 tests passing. On a `PATH` without the command, `node-pty` reports a non-zero
exit code rather than throwing — that's what the last test verifies.

- [ ] **Step 5: Fix node-pty's binary permissions**

`node-pty` ships an auxiliary executable, `spawn-helper`, that npm sometimes drops without the
execute bit. Every `spawn` then fails with an incomprehensible `posix_spawnp failed`, even for a
command as ordinary as `ls`. Since the repository is meant to be public, it's better to fix it
than to document it.

`scripts/fix-node-pty-permissions.mjs`:

```js
#!/usr/bin/env node
// npm sometimes drops node-pty's spawn-helper without the execute permission,
// which makes every process launch fail with an opaque message. We fix it
// instead of letting everyone discover it on their own.
import { chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const root = "node_modules/node-pty/prebuilds";

try {
  for (const dir of await readdir(root)) {
    const helper = join(root, dir, "spawn-helper");
    try {
      const info = await stat(helper);
      // 0o111: at least one execute bit.
      if ((info.mode & 0o111) === 0) {
        await chmod(helper, 0o755);
        console.log(`node-pty: execute permission restored on ${helper}`);
      }
    } catch {
      // No helper in this folder: nothing to do.
    }
  }
} catch {
  // node-pty missing or without prebuilds: the install shouldn't fail because of that.
}
```

Add to `package.json`:

```json
"postinstall": "node scripts/fix-node-pty-permissions.mjs"
```

Then verify the tests pass from a clean install of the binary:

Run: `chmod -x node_modules/node-pty/prebuilds/*/spawn-helper && npm run postinstall && npm test -- tests/runner/pty.test.ts`
Expected: the script reports the fix, then 4 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/runner/pty.ts tests/runner/pty.test.ts tests/fixtures/fake-fastlane scripts package.json
git commit -m "feat(runner): execution inside a pseudo-terminal and a fake fastlane for tests"
```

---

### Task 12: Orchestrating a run

The module that chains everything together: preparing the workspace, launching fastlane, writing
the log, reconciling the steps, collecting the artifacts, setting the final status.

**Files:**
- Create: `src/runner/orchestrate.ts`, `tests/runner/orchestrate.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/runner/orchestrate.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";
import { LogStore } from "../../src/logs/store.js";
import { executeRun } from "../../src/runner/orchestrate.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

const SETTINGS = {
  fastlane_dir: "fastlane",
  runtime: "system" as const,
  timeout_minutes: 5,
  interactive_default: false,
  artifact_globs: ["build/**/*.ipa"],
  required_secrets: [],
};

async function harness(scenario: "success" | "failure") {
  const origin = await makeOriginRepo({
    "fastlane/Fastfile": "lane :beta do\nend\n",
    // build/ is ignored: the artifact is produced by the fake fastlane during
    // the run, just like the real one. Nothing tracked by git is moved, so
    // the workspace stays clean for the next run.
    ".gitignore": "build/\n",
  });
  const root = await tmpDir("laneyard-root-");
  const db = openDatabase(":memory:");
  const runs = new RunStore(db);
  const logs = new LogStore(join(root, "logs"));

  const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

  const result = await executeRun({
    runId,
    runs,
    logs,
    workspacePath: join(root, "workspaces", "p"),
    artifactsDir: join(root, "artifacts", String(runId)),
    gitUrl: origin,
    branch: "main",
    resolveSettings: async () => SETTINGS,
    env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: scenario },
    onChunk: () => {},
  });

  return { runId, runs, logs, result };
}

describe("executeRun", () => {
  it("carries a run through to success end to end", async () => {
    const { runId, runs, logs } = await harness("success");
    const run = runs.get(runId)!;

    expect(run.status).toBe("success");
    expect(run.exitCode).toBe(0);
    expect(run.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(run.startedAt).not.toBeNull();
    expect(await logs.read(runId)).toContain("Step: build_app");
  }, 60_000);

  it("records the report's steps with the live-spotting offset", async () => {
    const { runId, runs } = await harness("success");
    const steps = runs.steps(runId);

    expect(steps.map((s) => s.name)).toEqual(["match", "build_app"]);
    expect(steps[0]!.source).toBe("report");
    expect(steps[0]!.durationMs).toBe(1500);
    expect(steps[1]!.logOffset).toBeGreaterThan(0);
  }, 60_000);

  it("collects the artifacts matching the patterns", async () => {
    const { runId, runs } = await harness("success");
    const arts = runs.artifacts(runId);

    expect(arts).toHaveLength(1);
    expect(arts[0]!.filename).toBe("Sample.ipa");
    expect(arts[0]!.kind).toBe("ipa");
  }, 60_000);

  it("marks the failure and keeps an error summary", async () => {
    const { runId, runs } = await harness("failure");
    const run = runs.get(runId)!;

    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(1);
    expect(runs.steps(runId).find((s) => s.name === "build_app")?.status).toBe("failed");
  }, 60_000);

  it("fails cleanly if resolving settings throws", async () => {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    await executeRun({
      runId,
      runs,
      logs,
      workspacePath: join(root, "ws"),
      artifactsDir: join(root, "art"),
      gitUrl: origin,
      branch: "main",
      // Real case: the project disappeared from config.yml during preparation.
      resolveSettings: async () => {
        throw new Error("unknown project");
      },
      env: {},
      onChunk: () => {},
    });

    const run = runs.get(runId)!;
    expect(run.status).toBe("failed");
    expect(run.errorSummary).toMatch(/unknown project/);
  }, 60_000);

  it("fails before launch if the repository is unreachable", async () => {
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    await executeRun({
      runId,
      runs,
      logs,
      workspacePath: join(root, "ws"),
      artifactsDir: join(root, "art"),
      gitUrl: "/nexiste/pas/depot.git",
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: {},
      onChunk: () => {},
    });

    const run = runs.get(runId)!;
    expect(run.status).toBe("failed");
    expect(run.errorSummary).toMatch(/git|repository|clone/i);
    // A run that never reached fastlane has no steps.
    expect(runs.steps(runId)).toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/runner/orchestrate.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the orchestration**

`src/runner/orchestrate.ts`:

```ts
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectSettings } from "../config/schema.js";
import type { RunStore, Step } from "../db/runs.js";
import { Workspace } from "../git/workspace.js";
import type { GitAuth } from "../git/workspace.js";
import type { LogStore } from "../logs/store.js";
import { summarizeFailure } from "../heuristics/error-summary.js";
import { collectArtifacts } from "./artifacts.js";
import { LiveStepTracker } from "./live-steps.js";
import { startPty } from "./pty.js";
import { readReport } from "./report.js";

export interface ExecuteRunOptions {
  runId: number;
  runs: RunStore;
  logs: LogStore;
  workspacePath: string;
  artifactsDir: string;
  gitUrl: string;
  gitAuth?: GitAuth;
  branch: string;
  /**
   * Resolves the effective settings. Called **after** the workspace is
   * prepared, because the laneyard.yml it reads lives in the repository:
   * on the first run, it doesn't exist on disk yet when the run is created.
   */
  resolveSettings: () => Promise<ProjectSettings>;
  env: NodeJS.ProcessEnv;
  /** Called for each output fragment, with its position in the log. */
  onChunk: (chunk: string, offset: number) => void;
}

export interface ExecuteRunResult {
  status: "success" | "failed";
}


/**
 * Runs a complete run through and sets its state transitions.
 *
 * Never throws: every error is converted into a documented `failed` run,
 * because a run that vanishes without a trace is the worst possible
 * behaviour for a build server.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<ExecuteRunResult> {
  const { runId, runs, logs } = opts;
  const writer = await logs.open(runId);
  const tracker = new LiveStepTracker();

  const emit = async (text: string): Promise<void> => {
    const offset = await writer.append(text);
    tracker.consume(text, offset);
    opts.onChunk(text, offset);
  };

  const fail = async (message: string): Promise<ExecuteRunResult> => {
    await emit(`\n${message}\n`);
    await writer.close();
    runs.finish(runId, { status: "failed", exitCode: null, errorSummary: message });
    return { status: "failed" };
  };

  // --- Preparation ---------------------------------------------------------
  runs.setStatus(runId, "preparing");
  const workspace = new Workspace(opts.workspacePath, opts.gitUrl, opts.gitAuth);

  let commitSha: string;
  try {
    commitSha = await workspace.prepare(opts.branch, (line) => void emit(`${line}\n`));
  } catch (cause) {
    return fail(`Could not prepare the workspace: ${(cause as Error).message}`);
  }

  runs.markRunning(runId, { branch: opts.branch, commitSha });

  // The workspace finally exists: only now is the repository's laneyard.yml
  // readable, so only now are the settings known. The resolution is guarded:
  // the project may have disappeared from config.yml during preparation,
  // and a run must never evaporate on an exception.
  let settings: ProjectSettings;
  try {
    settings = await opts.resolveSettings();
  } catch (cause) {
    return fail(`Unreadable project settings: ${(cause as Error).message}`);
  }

  // --- Execution -------------------------------------------------------------
  const useBundle = settings.runtime === "bundle";
  const reportPath = join(opts.workspacePath, settings.fastlane_dir, "report.xml");

  const { done } = startPty({
    command: useBundle ? "bundle" : "fastlane",
    args: useBundle
      ? ["exec", "fastlane", ...laneArgs(opts)]
      : laneArgs(opts),
    cwd: opts.workspacePath,
    env: {
      ...opts.env,
      // A non-interactive run fails fast instead of freezing on an invisible prompt.
      CI: "true",
      FASTLANE_SKIP_UPDATE_CHECK: "1",
      FORCE_COLOR: "1",
    },
    onData: (chunk) => void emit(chunk),
    timeoutMs: settings.timeout_minutes * 60_000,
  });

  const outcome = await done;
  await writer.close();

  // --- Timeline --------------------------------------------------------------
  const report = await readReport(reportPath);
  const live = tracker.steps();

  if (report) {
    // The report is authoritative; live spotting only contributes the offsets.
    const steps: Step[] = report.map((s, i) => ({
      idx: s.idx,
      name: s.name,
      durationMs: s.durationMs,
      status: s.status,
      logOffset: live[i]?.logOffset ?? null,
      source: "report",
    }));
    runs.replaceSteps(runId, steps);
    await rm(reportPath, { force: true });
  } else if (live.length > 0) {
    // Cancelled, timed out, or interrupted run: we keep what was seen, flagging it.
    runs.replaceSteps(
      runId,
      live.map((s, i) => ({
        idx: i,
        name: s.name,
        durationMs: null,
        status: "unknown",
        logOffset: s.logOffset,
        source: "live" as const,
      })),
    );
  }

  // --- Artifacts and final status -------------------------------------------
  const collected = await collectArtifacts(
    opts.workspacePath,
    settings.artifact_globs,
    opts.artifactsDir,
  );
  for (const a of collected) runs.addArtifact(runId, a);

  if (outcome.exitCode === 0 && !outcome.timedOut) {
    runs.finish(runId, { status: "success", exitCode: 0, errorSummary: null });
    return { status: "success" };
  }

  const summary = outcome.timedOut
    ? `Run interrupted after ${settings.timeout_minutes} minutes`
    : summarizeFailure(await logs.read(runId), outcome.exitCode);

  runs.finish(runId, { status: "failed", exitCode: outcome.exitCode, errorSummary: summary });
  return { status: "failed" };
}

function laneArgs(opts: ExecuteRunOptions): string[] {
  const run = opts.runs.get(opts.runId);
  if (!run) return [];
  const args = run.platform ? [run.platform, run.lane] : [run.lane];
  for (const [key, value] of Object.entries(run.params)) args.push(`${key}:${value}`);
  return args;
}
```

> **Divergence from what was built.** `src/heuristics/error-summary.ts` has no step of its own in
> this plan: the extraction happened during execution, once a real run showed the summary was
> keeping fastlane's generic closing line instead of the actual cause. The design document
> requires named knowledge of fastlane to live in an isolated module, so it was moved there rather
> than left inline. The repository is the reference; this plan records the intent.


- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/runner/orchestrate.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/runner/orchestrate.ts tests/runner/orchestrate.test.ts
git commit -m "feat(runner): complete orchestration of a run"
```

---

### Task 13: Live configuration state

**Files:**
- Create: `src/config/store.ts`, `tests/config/store.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/config/store.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { tmpDir } from "../fixtures/repos.js";

const CONFIG = (slug: string) => `
server: { password_hash: "x" }
projects:
  - slug: ${slug}
    git_url: u
`;

async function configFile(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-store-");
  const path = join(dir, "config.yml");
  await writeFile(path, content, "utf8");
  return path;
}

describe("ConfigStore", () => {
  it("loads the configuration at startup", async () => {
    const store = new ConfigStore(await configFile(CONFIG("sample")));
    await store.load();
    expect(store.projects().map((p) => p.slug)).toEqual(["sample"]);
  });

  it("finds a project by its slug", async () => {
    const store = new ConfigStore(await configFile(CONFIG("sample")));
    await store.load();
    expect(store.project("sample")?.git_url).toBe("u");
    expect(store.project("unknown")).toBeNull();
  });

  it("takes a file change into account", async () => {
    const path = await configFile(CONFIG("one"));
    const store = new ConfigStore(path);
    await store.load();

    await writeFile(path, CONFIG("two"), "utf8");
    await store.load();

    expect(store.projects().map((p) => p.slug)).toEqual(["two"]);
  });

  it("keeps the last valid configuration if the file becomes invalid", async () => {
    const path = await configFile(CONFIG("one"));
    const store = new ConfigStore(path);
    await store.load();

    await writeFile(path, "projects: [", "utf8");
    const res = await store.load();

    expect(res.ok).toBe(false);
    expect(store.projects().map((p) => p.slug)).toEqual(["one"]);
    expect(store.lastError()).not.toBeNull();
  });

  it("clears the error once the file becomes valid again", async () => {
    const path = await configFile(CONFIG("one"));
    const store = new ConfigStore(path);
    await store.load();
    await writeFile(path, "projects: [", "utf8");
    await store.load();

    await writeFile(path, CONFIG("one"), "utf8");
    await store.load();

    expect(store.lastError()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/config/store.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the configuration store**

`src/config/store.ts`:

```ts
import { watch } from "node:fs";
import { loadRepoConfig, loadServerConfig } from "./load.js";
import { resolveProjectSettings } from "./resolve.js";
import type { Origin } from "./resolve.js";
import type { ProjectEntry, ProjectSettings, ServerConfig } from "./schema.js";
import { join } from "node:path";

export interface ResolvedProject {
  entry: ProjectEntry;
  settings: ProjectSettings;
  provenance: Record<keyof ProjectSettings, Origin>;
}

/**
 * The server's live configuration.
 *
 * Safety rule: an invalid configuration never replaces a valid one. The
 * server keeps running with what it had, and the error is exposed to the
 * interface — never a half-configured startup.
 */
export class ConfigStore {
  private config: ServerConfig | null = null;
  private error: string | null = null;

  constructor(private readonly path: string) {}

  async load(): Promise<{ ok: boolean; error?: string }> {
    const res = await loadServerConfig(this.path);
    if (!res.ok) {
      this.error = res.error;
      return { ok: false, error: res.error };
    }
    this.config = res.config;
    this.error = null;
    return { ok: true };
  }

  /** Watches the file and reloads, absorbing bursts of events. */
  watch(onReload: (ok: boolean) => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(this.path, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void this.load().then((r) => onReload(r.ok));
      }, 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  }

  server(): ServerConfig["server"] | null {
    return this.config?.server ?? null;
  }

  projects(): ProjectEntry[] {
    return this.config?.projects ?? [];
  }

  project(slug: string): ProjectEntry | null {
    return this.projects().find((p) => p.slug === slug) ?? null;
  }

  lastError(): string | null {
    return this.error;
  }

  /**
   * Resolves a project's effective settings by reading its workspace's
   * laneyard.yml if it exists. The workspace may not be cloned yet: we
   * then fall back to the project's block and the defaults.
   */
  async resolve(slug: string, workspacePath: string): Promise<ResolvedProject | null> {
    const entry = this.project(slug);
    if (!entry) return null;

    const repoRes = await loadRepoConfig(join(workspacePath, "laneyard.yml"));
    const repo = repoRes.ok ? repoRes.config : null;

    const { settings, provenance } = resolveProjectSettings(entry, repo);
    return { entry, settings, provenance };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/config/store.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/config/store.ts tests/config/store.test.ts
git commit -m "feat(config): live state, reloading, and per-project resolution"
```

---

### Task 14: HTTP server, authentication, and API

**Files:**
- Create: `src/server/auth.ts`, `src/server/app.ts`, `src/server/routes/projects.ts`, `src/server/routes/runs.ts`, `tests/server/api.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/server/api.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import { buildApp } from "../../src/server/app.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

async function harness() {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
  const root = await tmpDir("laneyard-api-");
  const configPath = join(root, "config.yml");
  await writeFile(
    configPath,
    `
server:
  password_hash: "${hashPassword("secret")}"
projects:
  - slug: sample
    name: Sample
    git_url: ${origin}
`,
    "utf8",
  );

  const config = new ConfigStore(configPath);
  await config.load();

  const app = await buildApp({
    config,
    db: openDatabase(":memory:"),
    root,
    lanes: async () => [{ name: "beta", platform: "ios", description: "Beta", private: false }],
  });

  return { app, root };
}

async function login(app: Awaited<ReturnType<typeof harness>>["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "secret" },
  });
  return res.cookies[0]!.value;
}

describe("API", () => {
  it("refuses access without a session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a wrong password", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("lists the projects once logged in", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      cookies: { laneyard_session: session },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ slug: "sample", name: "Sample" }]);
  });

  it("returns a project's lanes", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sample/lanes",
      cookies: { laneyard_session: session },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ name: "beta", platform: "ios" }]);
  });

  it("responds 404 for a project absent from the configuration", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/unknown/lanes",
      cookies: { laneyard_session: session },
    });
    expect(res.statusCode).toBe(404);
  });

  it("creates a queued run and makes it viewable", async () => {
    const { app } = await harness();
    const session = await login(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies: { laneyard_session: session },
      payload: { lane: "beta", platform: "ios", params: {} },
    });

    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: number };

    const fetched = await app.inject({
      method: "GET",
      url: `/api/runs/${id}`,
      cookies: { laneyard_session: session },
    });
    expect(fetched.json()).toMatchObject({ id, lane: "beta", projectSlug: "sample" });
  });

  it("refuses to launch an unknown lane", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies: { laneyard_session: session },
      payload: { lane: "does-not-exist", params: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/server/api.test.ts`
Expected: failure — modules not found.

- [ ] **Step 3: Implement authentication and the application**

`src/server/auth.ts`:

```ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * scrypt from the standard library: no extra native dependency, and enough
 * computational resistance for a single local password.
 * Format: scrypt$<hex salt>$<hex key>.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

/** In-memory sessions: they don't survive a restart, and that's just fine. */
export class SessionStore {
  private readonly tokens = new Set<string>();

  issue(): string {
    const token = randomBytes(32).toString("hex");
    this.tokens.add(token);
    return token;
  }

  valid(token: string | undefined): boolean {
    return token !== undefined && this.tokens.has(token);
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

export const SESSION_COOKIE = "laneyard_session";
```

`src/server/app.ts`:

```ts
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import type { ConfigStore } from "../config/store.js";
import type { Db } from "../db/open.js";
import { RunStore } from "../db/runs.js";
import { Workspace } from "../git/workspace.js";
import { LogStore } from "../logs/store.js";
import type { Lane } from "../sidecar/lanes.js";
import { SESSION_COOKIE, SessionStore, verifyPassword } from "./auth.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerWebSocket } from "./ws.js";
import type { RunSockets } from "./ws.js";

export interface AppDeps {
  config: ConfigStore;
  db: Db;
  /** Data root: workspaces, logs, artifacts. */
  root: string;
  /** Injected so tests don't need Ruby or fastlane. */
  lanes: (slug: string, workspacePath: string, fastlaneDir: string) => Promise<Lane[]>;
}

export interface AppContext extends AppDeps {
  runs: RunStore;
  logs: LogStore;
  sessions: SessionStore;
  sockets?: RunSockets;
  workspacePath: (slug: string) => string;
  artifactsDir: (runId: number) => string;
  /** Clones the repository if it isn't cloned yet. Throws if the clone fails. */
  ensureWorkspace: (slug: string) => Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    broadcastRunChunk?: (runId: number, chunk: string, offset: number) => void;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  const workspacePath = (slug: string) => join(deps.root, "workspaces", slug);

  const ctx: AppContext = {
    ...deps,
    runs: new RunStore(deps.db),
    logs: new LogStore(join(deps.root, "logs")),
    sessions: new SessionStore(),
    workspacePath,
    artifactsDir: (runId) => join(deps.root, "artifacts", String(runId)),
    ensureWorkspace: async (slug) => {
      const entry = deps.config.project(slug);
      if (!entry) throw new Error(`Unknown project: ${slug}`);
      await new Workspace(workspacePath(slug), entry.git_url, entry.git_auth).ensureCloned();
    },
  };

  app.post("/api/login", async (req, reply) => {
    const { password } = req.body as { password?: string };
    const hash = deps.config.server()?.password_hash;

    if (!password || !hash || !verifyPassword(password, hash)) {
      return reply.code(401).send({ error: "Incorrect password" });
    }

    const token = ctx.sessions.issue();
    return reply
      .setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax" })
      .send({ ok: true });
  });

  // Every /api route except /api/login requires a session.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api") || req.url === "/api/login") return;
    if (!ctx.sessions.valid(req.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: "Session required" });
    }
  });

  ctx.sockets = await registerWebSocket(app, ctx);

  await registerProjectRoutes(app, ctx);
  await registerRunRoutes(app, ctx);

  return app;
}
```

`src/server/routes/projects.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";

export async function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/projects", async () =>
    ctx.config.projects().map((p) => {
      const last = ctx.runs.listByProject(p.slug, 1)[0] ?? null;
      return {
        slug: p.slug,
        name: p.name,
        color: p.color,
        lastRun: last && { id: last.id, status: last.status, lane: last.lane, finishedAt: last.finishedAt },
      };
    }),
  );

  app.get("/api/projects/:slug/lanes", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });

    try {
      // Lanes live in the repository: with no clone, there's nothing to read.
      // A freshly declared project must be usable without launching a run blind.
      await ctx.ensureWorkspace(slug);
      const resolved = await ctx.config.resolve(slug, ctx.workspacePath(slug));
      return await ctx.lanes(slug, ctx.workspacePath(slug), resolved!.settings.fastlane_dir);
    } catch (cause) {
      // Workspace not cloned yet, broken Fastfile, sidecar failure: the
      // interface must be able to tell the user, rather than show an empty list.
      return reply.code(503).send({ error: (cause as Error).message });
    }
  });

  app.get("/api/projects/:slug/runs", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return ctx.runs.listByProject(slug);
  });
}
```

`src/server/routes/runs.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import type { AppContext } from "../app.js";
import { executeRun } from "../../runner/orchestrate.js";

export async function registerRunRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/api/projects/:slug/runs", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as { lane?: string; platform?: string | null; params?: Record<string, string> };

    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });
    if (!body.lane) return reply.code(400).send({ error: "Missing lane" });

    // We check that the lane genuinely exists before creating a run doomed to fail.
    try {
      await ctx.ensureWorkspace(slug);
      const resolved = await ctx.config.resolve(slug, ctx.workspacePath(slug));
      const lanes = await ctx.lanes(slug, ctx.workspacePath(slug), resolved!.settings.fastlane_dir);
      if (!lanes.some((l) => l.name === body.lane)) {
        return reply.code(400).send({ error: `Unknown lane: ${body.lane}` });
      }
    } catch {
      // Unreadable lanes: we let it through, the run will fail with a clear message.
    }

    const id = ctx.runs.create({
      projectSlug: slug,
      lane: body.lane,
      platform: body.platform ?? null,
      params: body.params ?? {},
    });

    // Launched without waiting: the HTTP response mustn't take as long as a build.
    void executeRun({
      runId: id,
      runs: ctx.runs,
      logs: ctx.logs,
      workspacePath: ctx.workspacePath(slug),
      artifactsDir: ctx.artifactsDir(id),
      gitUrl: entry.git_url,
      gitAuth: entry.git_auth,
      branch: entry.default_branch,
      // Resolved after the clone, once the repository's laneyard.yml is finally readable.
      resolveSettings: async () => {
        const r = await ctx.config.resolve(slug, ctx.workspacePath(slug));
        return r!.settings;
      },
      env: process.env,
      onChunk: (chunk, offset) => app.broadcastRunChunk?.(id, chunk, offset),
    });

    return reply.code(201).send({ id });
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const run = ctx.runs.get(id);
    if (!run) return reply.code(404).send({ error: "Unknown run" });
    return { ...run, steps: ctx.runs.steps(id), artifacts: ctx.runs.artifacts(id) };
  });

  app.get("/api/runs/:id/log", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const from = Number((req.query as { from?: string }).from ?? 0);
    if (!ctx.runs.get(id)) return reply.code(404).send({ error: "Unknown run" });
    return reply.type("text/plain; charset=utf-8").send(await ctx.logs.read(id, from));
  });

  app.get("/api/runs/:id/artifacts/:artifactId", async (req, reply) => {
    const { id, artifactId } = req.params as { id: string; artifactId: string };
    const artifact = ctx.runs.artifacts(Number(id)).find((a) => a.id === Number(artifactId));
    if (!artifact) return reply.code(404).send({ error: "Unknown artifact" });

    return reply
      .header("Content-Disposition", `attachment; filename="${artifact.filename}"`)
      .type("application/octet-stream")
      .send(createReadStream(artifact.path));
  });
}
```

> `app.ts` imports `registerWebSocket` and the `RunSockets` type from Task 15. For this task's
> tests to run before that, create a **functional** provisional `src/server/ws.ts` — an empty
> module isn't enough, the import would fail:
>
> ```ts
> import type { FastifyInstance } from "fastify";
>
> export class RunSockets {
>   broadcast(_runId: number, _chunk: string, _offset: number): void {}
>   finish(_runId: number, _status: string): void {}
> }
>
> // The signature already accepts the arguments from the call site in `app.ts`,
> // otherwise typing would fail before Task 15 even exists.
> export async function registerWebSocket(
>   _app?: FastifyInstance,
>   _ctx?: unknown,
> ): Promise<RunSockets> {
>   return new RunSockets();
> }
> ```
>
> Task 15 replaces it with the real implementation and its tests.

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/server/api.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/server tests/server
git commit -m "feat(server): session authentication and the projects/runs API"
```

---

### Task 15: Broadcasting logs over WebSocket

**Files:**
- Create: `src/server/ws.ts`, `tests/server/ws.test.ts`
- Modify: `src/server/app.ts` (register the module)

- [ ] **Step 1: Write the failing tests**

`tests/server/ws.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RunSockets } from "../../src/server/ws.js";

interface FakeSocket {
  sent: string[];
  send(data: string): void;
}

const socket = (): FakeSocket => ({ sent: [], send(d) { this.sent.push(d); } });

describe("RunSockets", () => {
  it("broadcasts a fragment to the run's subscribers", () => {
    const hub = new RunSockets();
    const a = socket();
    hub.subscribe(1, a);

    hub.broadcast(1, "output", 10);

    expect(JSON.parse(a.sent[0]!)).toEqual({ type: "chunk", offset: 10, data: "output" });
  });

  it("sends nothing to another run's subscribers", () => {
    const hub = new RunSockets();
    const other = socket();
    hub.subscribe(2, other);

    hub.broadcast(1, "output", 0);

    expect(other.sent).toEqual([]);
  });

  it("stops writing to an unsubscribed subscriber", () => {
    const hub = new RunSockets();
    const s = socket();
    hub.subscribe(1, s);
    hub.unsubscribe(1, s);

    hub.broadcast(1, "output", 0);

    expect(s.sent).toEqual([]);
  });

  it("survives a subscriber whose send fails", () => {
    const hub = new RunSockets();
    const broken = { send() { throw new Error("closed socket"); } };
    const healthy = socket();
    hub.subscribe(1, broken);
    hub.subscribe(1, healthy);

    expect(() => hub.broadcast(1, "output", 0)).not.toThrow();
    expect(healthy.sent).toHaveLength(1);
  });

  it("announces the end of a run", () => {
    const hub = new RunSockets();
    const s = socket();
    hub.subscribe(1, s);

    hub.finish(1, "success");

    expect(JSON.parse(s.sent[0]!)).toEqual({ type: "finished", status: "success" });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/server/ws.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the hub and wire it in**

`src/server/ws.ts`:

```ts
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { AppContext } from "./app.js";
import { SESSION_COOKIE } from "./auth.js";

/** All the hub needs from a client: the ability to receive text. */
export interface Sink {
  send(data: string): void;
}

/**
 * Broadcasts output fragments to browsers watching a run.
 *
 * Every message carries its byte offset: a client that reconnects requests
 * the log from its last known offset and loses nothing.
 */
export class RunSockets {
  private readonly byRun = new Map<number, Set<Sink>>();

  subscribe(runId: number, sink: Sink): void {
    const set = this.byRun.get(runId) ?? new Set<Sink>();
    set.add(sink);
    this.byRun.set(runId, set);
  }

  unsubscribe(runId: number, sink: Sink): void {
    const set = this.byRun.get(runId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.byRun.delete(runId);
  }

  private emit(runId: number, payload: unknown): void {
    const set = this.byRun.get(runId);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const sink of set) {
      try {
        sink.send(data);
      } catch {
        // A dead client must never interrupt the broadcast to the others.
        set.delete(sink);
      }
    }
  }

  broadcast(runId: number, chunk: string, offset: number): void {
    this.emit(runId, { type: "chunk", offset, data: chunk });
  }

  finish(runId: number, status: string): void {
    this.emit(runId, { type: "finished", status });
  }
}

export async function registerWebSocket(app: FastifyInstance, ctx: AppContext): Promise<RunSockets> {
  const hub = new RunSockets();
  await app.register(websocket);

  app.get("/api/runs/:id/stream", { websocket: true }, (socket, req) => {
    // Deliberate redundancy: `app.ts`'s global hook already refuses every
    // `/api` route without a session, and does so right at the handshake —
    // an unauthenticated client gets a 401 HTTP response and never reaches
    // here. This guard costs nothing and prevents a future exemption of
    // that hook from silently opening the stream.
    if (!ctx.sessions.valid(req.cookies[SESSION_COOKIE])) {
      socket.close(4001, "Session required");
      return;
    }

    const runId = Number((req.params as { id: string }).id);
    const sink: Sink = { send: (d) => socket.send(d) };

    hub.subscribe(runId, sink);
    socket.on("close", () => hub.unsubscribe(runId, sink));
  });

  app.decorate("broadcastRunChunk", (runId: number, chunk: string, offset: number) =>
    hub.broadcast(runId, chunk, offset),
  );

  return hub;
}
```

`src/server/app.ts` already calls `registerWebSocket` (Task 14): replacing the provisional module
with this one is enough. In `routes/runs.ts`, notify the run's end:

```ts
void executeRun({ /* … */ }).then((r) => ctx.sockets?.finish(id, r.status));
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all tests pass, including the 5 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/server tests/server/ws.test.ts
git commit -m "feat(server): broadcasting logs over WebSocket"
```

---

### Task 16: Entry point

**Files:**
- Create: `src/main.ts` (replaces Task 1's content), `tests/main.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/main.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerFromConfig } from "../src/main.js";
import { hashPassword } from "../src/server/auth.js";
import { openDatabase } from "../src/db/open.js";
import { RunStore } from "../src/db/runs.js";
import { tmpDir } from "./fixtures/repos.js";

describe("createServerFromConfig", () => {
  it("refuses to start if the configuration is invalid", async () => {
    const root = await tmpDir("laneyard-main-");
    await writeFile(join(root, "config.yml"), "projects: [", "utf8");
    await expect(createServerFromConfig(root)).rejects.toThrow(/configuration/i);
  });

  it("marks runs still active at startup as interrupted", async () => {
    const root = await tmpDir("laneyard-main-");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.yml"),
      `server: { password_hash: "${hashPassword("x")}" }\nprojects: []\n`,
      "utf8",
    );

    const dbPath = join(root, "laneyard.db");
    const runs = new RunStore(openDatabase(dbPath));
    const id = runs.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    runs.markRunning(id, { branch: "main", commitSha: "x" });

    const { app, db } = await createServerFromConfig(root);
    await app.close();

    expect(new RunStore(db).get(id)?.status).toBe("interrupted");
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npm test -- tests/main.test.ts`
Expected: failure — `createServerFromConfig` doesn't exist.

- [ ] **Step 3: Write the entry point**

`src/main.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ConfigStore } from "./config/store.js";
import { CacheStore } from "./db/cache.js";
import { openDatabase } from "./db/open.js";
import type { Db } from "./db/open.js";
import { RunStore } from "./db/runs.js";
import { buildApp } from "./server/app.js";
import { makeInvoke } from "./sidecar/bridge.js";
import { LaneReader } from "./sidecar/lanes.js";

export const version = "0.1.0";

export interface Started {
  app: FastifyInstance;
  db: Db;
  config: ConfigStore;
}

/** Assembles the server from a data folder. */
export async function createServerFromConfig(root: string): Promise<Started> {
  const config = new ConfigStore(join(root, "config.yml"));
  const loaded = await config.load();
  if (!loaded.ok) throw new Error(`Unreadable configuration: ${loaded.error}`);

  const db = openDatabase(join(root, "laneyard.db"));

  // No run can survive the shutdown of the process that carried it.
  new RunStore(db).interruptActive();

  const cache = new CacheStore(db);
  const app = await buildApp({
    config,
    db,
    root,
    lanes: async (slug, workspacePath, fastlaneDir) => {
      const resolved = await config.resolve(slug, workspacePath);
      const reader = new LaneReader(cache, makeInvoke(resolved?.settings.runtime ?? "bundle"));
      return reader.read(slug, workspacePath, fastlaneDir);
    },
  });

  return { app, db, config };
}

/** Real startup, outside tests. */
async function main(): Promise<void> {
  const root = process.env["LANEYARD_HOME"] ?? join(homedir(), ".laneyard");
  const { app, config } = await createServerFromConfig(root);

  config.watch((ok) => {
    if (!ok) console.error(`Invalid configuration, the previous one stays active: ${config.lastError()}`);
  });

  const server = config.server()!;
  await app.listen({ port: server.port, host: server.bind });
  console.log(`Laneyard is listening on http://localhost:${server.port}`);
}

if (process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js")) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
```

Adapt `tests/smoke.test.ts` if needed: `version` is still exported.

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/main.test.ts
git commit -m "feat: entry point and server assembly"
```

---

### Task 17: Interface — skeleton and theme

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/components/Login.tsx`, `web/src/theme.css`, `web/src/api.ts`
- Modify: `package.json` (frontend dependencies and scripts)

- [ ] **Step 1: Install the frontend**

```bash
npm install --save-dev @vitejs/plugin-react vite
npm install react react-dom react-router-dom
npm install --save-dev @types/react @types/react-dom
```

Add to `package.json`:

```json
"scripts": {
  "dev:web": "vite --config web/vite.config.ts",
  "build:web": "vite build --config web/vite.config.ts"
}
```

- [ ] **Step 2: Write the theme**

`web/src/theme.css` — the tokens for the validated visual direction. Dark by default, light
available, terminal area dark in both cases.

```css
:root {
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  --bg: #14161a;
  --bg-raised: #1b1e24;
  --bg-inset: #171a1f;
  --border: #262a31;
  --text: #c8ccd4;
  --text-dim: #676e7b;
  --text-bright: #e6e9ee;

  --accent: #7ee787;
  --ok: #7ee787;
  --running: #e3b341;
  --error: #f8746a;
  --info: #79c0ff;

  /* The terminal area doesn't follow the theme: fastlane's ANSI colors
     are designed for a black background, re-translating them would betray the output. */
  --term-bg: #0e1013;
  --term-text: #c9d1d9;
}

:root[data-theme="light"] {
  --bg: #f2efe6;
  --bg-raised: #e7e2d5;
  --bg-inset: #ebe7dc;
  --border: #d9d3c4;
  --text: #2f2b25;
  --text-dim: #8b8375;
  --text-bright: #14110c;

  --accent: #3f7d3f;
  --ok: #3f7d3f;
  --running: #a76c14;
  --error: #b03a34;
  --info: #2f6f9e;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  /* Fixed-width type across the whole interface: it's the most structural
     choice in the visual direction, it tolerates no exception. */
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
}

/* Right angles, one-pixel rules, no shadow or gradient:
   surfaces are told apart by value, not by depth. */
.panel { background: var(--bg-raised); border: 1px solid var(--border); }

.status-success { color: var(--ok); }
.status-running { color: var(--running); }
.status-failed,
.status-interrupted { color: var(--error); }
.status-queued,
.status-preparing { color: var(--text-dim); }
```

`web/src/api.ts`:

```ts
const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
  return (await res.json()) as T;
};

export interface ProjectSummary {
  slug: string;
  name: string;
  color: string;
  lastRun: { id: number; status: string; lane: string; finishedAt: string | null } | null;
}

export interface Lane {
  name: string;
  platform: string | null;
  description: string;
  private: boolean;
}

export interface RunDetail {
  id: number;
  projectSlug: string;
  lane: string;
  status: string;
  branch: string | null;
  commitSha: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorSummary: string | null;
  steps: { idx: number; name: string; durationMs: number | null; status: string; logOffset: number | null }[];
  artifacts: { id: number; filename: string; size: number; kind: string }[];
}

export const api = {
  login: (password: string) =>
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).then((r) => r.ok),

  projects: () => fetch("/api/projects").then(json<ProjectSummary[]>),
  lanes: (slug: string) => fetch(`/api/projects/${slug}/lanes`).then(json<Lane[]>),
  runsOf: (slug: string) => fetch(`/api/projects/${slug}/runs`).then(json<RunDetail[]>),
  run: (id: number) => fetch(`/api/runs/${id}`).then(json<RunDetail>),
  log: (id: number, from = 0) => fetch(`/api/runs/${id}/log?from=${from}`).then((r) => r.text()),

  trigger: (slug: string, lane: string, platform: string | null, params: Record<string, string>) =>
    fetch(`/api/projects/${slug}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane, platform, params }),
    }).then(json<{ id: number }>),
};
```

`web/index.html`:

```html
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>laneyard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

`web/src/App.tsx` — navigation shell. The screens arrive in Tasks 18 and 19; at this stage,
empty components are enough to get the project building.

```tsx
import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { Login } from "./components/Login";
import { api } from "./api";

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    // A 401 on this call means it's time to log in.
    api
      .projects()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);

  if (authenticated === null) return <p className="dim">loading…</p>;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  return (
    <div className="shell">
      <header>laneyard</header>
      <Routes>
        <Route path="/" element={<p className="dim">projects</p>} />
      </Routes>
    </div>
  );
}
```

`web/vite.config.ts` — the root resolves from the configuration file's folder, so it must
absolutely not be re-added as `"web"` there.

```ts
import react from "@vitejs/plugin-react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: join(here, "..", "dist", "web"), emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://localhost:7890", ws: true },
    },
  },
});
```

`web/src/components/Login.tsx` must exist before this skeleton builds: either take it as-is
from Task 18, or write a minimal version here and complete it afterwards.

- [ ] **Step 3: Verify the frontend builds**

Run: `npm run build:web`
Expected: successful build, files emitted in `dist/web`.

- [ ] **Step 4: Commit**

```bash
git add web package.json package-lock.json
git commit -m "feat(web): Vite skeleton, theme, and API client"
```

---

### Task 18: Interface — project list, lanes, and triggering

**Files:**
- Create: `web/src/App.tsx`, `web/src/pages/Projects.tsx`, `web/src/pages/Project.tsx`, `web/src/components/Login.tsx`

- [ ] **Step 1: Write the screens**

`web/src/pages/Projects.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { ProjectSummary } from "../api";

const MARK: Record<string, string> = {
  success: "✓",
  failed: "✗",
  interrupted: "✗",
  running: "▸",
  preparing: "▸",
  queued: "○",
};

export function Projects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then(setProjects).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="status-failed">{error}</p>;

  if (projects.length === 0) {
    return (
      <p className="dim">
        No projects declared. Add a block in <code>~/.laneyard/config.yml</code>.
      </p>
    );
  }

  return (
    <ul className="projects">
      {projects.map((p) => (
        <li key={p.slug}>
          <Link to={`/p/${p.slug}`}>
            <span className={`status-${p.lastRun?.status ?? "queued"}`}>
              {MARK[p.lastRun?.status ?? "queued"]}
            </span>{" "}
            {p.name}
          </Link>
          {p.lastRun && <span className="dim"> {p.lastRun.lane}</span>}
        </li>
      ))}
    </ul>
  );
}
```

`web/src/pages/Project.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import type { Lane, RunDetail } from "../api";

export function Project() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [runs, setRuns] = useState<RunDetail[]>([]);
  const [lanesError, setLanesError] = useState<string | null>(null);

  useEffect(() => {
    api.lanes(slug).then(setLanes).catch((e: Error) => setLanesError(e.message));
    api.runsOf(slug).then(setRuns).catch(() => {});
  }, [slug]);

  const trigger = async (lane: Lane) => {
    const { id } = await api.trigger(slug, lane.name, lane.platform, {});
    navigate(`/r/${id}`);
  };

  return (
    <>
      <h2>lanes</h2>
      {/* A lane-reading error is stated, never hidden behind an empty list. */}
      {lanesError && <p className="status-failed">Unreadable lanes — {lanesError}</p>}
      <ul>
        {lanes
          .filter((l) => !l.private)
          .map((l) => (
            <li key={`${l.platform ?? ""}:${l.name}`}>
              <button onClick={() => void trigger(l)}>▶</button> {l.name}{" "}
              <span className="dim">{l.platform}</span>
              <div className="dim">{l.description}</div>
            </li>
          ))}
      </ul>

      <h2>runs</h2>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <Link to={`/r/${r.id}`} className={`status-${r.status}`}>
              #{r.id} {r.lane} — {r.status}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
```

`web/src/components/Login.tsx`:

```tsx
import { useState } from "react";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [failed, setFailed] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { api } = await import("../api");
    if (await api.login(password)) onSuccess();
    else setFailed(true);
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <label>
        password{" "}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </label>
      <button type="submit">enter</button>
      {failed && <p className="status-failed">Incorrect password</p>}
    </form>
  );
}
```

`web/src/App.tsx` and `web/src/main.tsx`: routing between `/`, `/p/:slug`, and `/r/:id`, with the
projects sidebar and the login screen shown as long as a call returns 401.

- [ ] **Step 2: Verify manually**

```bash
# Terminal 1
LANEYARD_HOME=/tmp/laneyard-demo npm run dev
# Terminal 2
npm run dev:web
```

Create `/tmp/laneyard-demo/config.yml` with a project pointing at a real repository, then open
`http://localhost:5173`. Verify: login, project list, lane list, triggering.

- [ ] **Step 3: Commit**

```bash
git add web/src
git commit -m "feat(web): project list, lanes, and triggering a run"
```

---

### Task 19: Interface — run screen and live terminal

**Files:**
- Create: `web/src/pages/Run.tsx`, `web/src/components/Terminal.tsx`, `web/src/useRunStream.ts`

- [ ] **Step 1: Write the stream tracking**

`web/src/useRunStream.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * Follows a run's output.
 *
 * The byte offset is the key to resuming: on connection as after a drop,
 * we request the log again from the last known offset, then pick back up
 * from the stream. Nothing is lost, nothing is duplicated.
 */
export function useRunStream(runId: number): { log: string; finished: string | null } {
  const [log, setLog] = useState("");
  const [finished, setFinished] = useState<string | null>(null);
  const offset = useRef(0);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;

    const connect = async () => {
      const backlog = await api.log(runId, offset.current);
      if (closed) return;
      if (backlog) {
        offset.current += new TextEncoder().encode(backlog).byteLength;
        setLog((prev) => prev + backlog);
      }

      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/api/runs/${runId}/stream`);

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as
          | { type: "chunk"; offset: number; data: string }
          | { type: "finished"; status: string };

        if (msg.type === "chunk") {
          // A fragment already covered by the catch-up is ignored.
          if (msg.offset < offset.current) return;
          offset.current = msg.offset + new TextEncoder().encode(msg.data).byteLength;
          setLog((prev) => prev + msg.data);
        } else {
          setFinished(msg.status);
        }
      };

      socket.onclose = () => {
        if (!closed && !finished) setTimeout(() => void connect(), 1000);
      };
    };

    void connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, [runId]);

  return { log, finished };
}
```

`web/src/components/Terminal.tsx`: `<pre>` on a `--term-bg` background, auto-scrolling as long as
the user hasn't scrolled up manually, and a disabled input line carrying its reason —
"interactive mode disabled" — in line with the spec.

`web/src/pages/Run.tsx`: header (lane, branch, commit, status, duration), step timeline on the
left, terminal on the right, downloadable artifacts at the bottom. Steps with a `logOffset`
scroll the terminal to the right position on click.

- [ ] **Step 2: Verify manually**

Trigger a run from the interface and verify: the output arrives live, the steps appear
at the end of the run, the artifact downloads, and reloading the page mid-run loses no line.

- [ ] **Step 3: Serve the built SPA from the server**

Without this, the application is only accessible behind the Vite dev server, and
reloading on `/r/42` returns 404. In `src/server/app.ts`, after the routes:

```ts
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// …
// Resolved from the module's location, not from the data folder:
// `deps.root` is ~/.laneyard, the built SPA lives in the repository.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "web");
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  // Routing lives on the browser side: any unknown URL renders the app.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) return reply.code(404).send({ error: "Unknown route" });
    return reply.sendFile("index.html");
  });
}
```

In development, `dist/web` doesn't exist and the block is simply skipped: the Vite proxy takes
over.

- [ ] **Step 4: Commit**

```bash
git add web/src src/server/app.ts
git commit -m "feat(web): run screen, live terminal, and artifacts"
```

---

### Task 20: End-to-end verification

**Files:**
- Create: `tests/e2e/full-thread.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/e2e/full-thread.test.ts` — the milestone's full thread, without a browser: configuration on
disk, a real git repository, a fake fastlane, the HTTP API.

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerFromConfig } from "../../src/main.js";
import { hashPassword } from "../../src/server/auth.js";
import { RunStore } from "../../src/db/runs.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

describe("full thread", () => {
  it("declares, clones, lists, triggers, follows, and retrieves the artifact", async () => {
    const origin = await makeOriginRepo({
      "fastlane/Fastfile": "lane :beta do\nend\n",
      "laneyard.yml": 'runtime: system\nartifact_globs: ["build/**/*.ipa"]\n',
      ".gitignore": "build/\n",
    });
    const root = await tmpDir("laneyard-e2e-");

    await writeFile(
      join(root, "config.yml"),
      `
server:
  password_hash: "${hashPassword("secret")}"
projects:
  - slug: sample
    name: Sample
    git_url: ${origin}
`,
      "utf8",
    );

    process.env["PATH"] = `${FAKE_DIR}:${process.env["PATH"]}`;
    process.env["FAKE_FASTLANE_SCENARIO"] = "success";

    const { app, db } = await createServerFromConfig(root);
    const session = (
      await app.inject({ method: "POST", url: "/api/login", payload: { password: "secret" } })
    ).cookies[0]!.value;
    const cookies = { laneyard_session: session };

    const projects = await app.inject({ method: "GET", url: "/api/projects", cookies });
    expect(projects.json()).toMatchObject([{ slug: "sample" }]);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: number };

    // The run is asynchronous: we wait for it to reach a terminal state.
    const runs = new RunStore(db);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = runs.get(id)?.status;
      if (status === "success" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const detail = await app.inject({ method: "GET", url: `/api/runs/${id}`, cookies });
    const body = detail.json() as { status: string; steps: unknown[]; artifacts: { id: number; filename: string }[] };

    expect(body.status).toBe("success");
    expect(body.steps).toHaveLength(2);
    expect(body.artifacts[0]!.filename).toBe("Sample.ipa");

    const log = await app.inject({ method: "GET", url: `/api/runs/${id}/log`, cookies });
    expect(log.body).toContain("Step: build_app");

    const download = await app.inject({
      method: "GET",
      url: `/api/runs/${id}/artifacts/${body.artifacts[0]!.id}`,
      cookies,
    });
    expect(download.statusCode).toBe(200);
    expect(download.body.trim()).toBe("fake binary");

    await app.close();
  }, 120_000);
});
```

Along the way, this test verifies two non-obvious things: that the repository's `laneyard.yml` is
taken into account — without it, `runtime` would be `bundle` and the artifact patterns would be
empty — and that it is **from the very first run**, even though the file didn't exist on disk at
the moment the run was created. This is the scenario that the late resolution of settings exists
to cover.

It also verifies that the workspace stays clean: the artifact is produced by the run in a folder
ignored by git, so moving it doesn't leave an uncommitted change that would make the next run
fail.

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/e2e/full-thread.test.ts`
Expected: 1 test passing. On failure, read the run's log — it's in
`<root>/logs/<id>.log` and contains the fake fastlane's output.

- [ ] **Step 3: Run the whole suite and the type check**

Run: `npm test && npm run typecheck`
Expected: everything passes.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e
git commit -m "test: end-to-end verification of the full thread"
```

---

### Task 21: The `laneyard add` command — adopting an existing fastlane project

The real use case isn't starting from a blank page but from a project that already uses
fastlane. The command runs from the project's folder, detects what it can, and writes the
corresponding block into `config.yml` — without ever touching the rest of the file.

**Files:**
- Create: `src/cli/detect.ts`, `src/cli/add.ts`, `tests/cli/detect.test.ts`, `tests/cli/add.test.ts`
- Modify: `src/main.ts` (command dispatch), `package.json` (`bin` field)

- [ ] **Step 1: Write the detection tests**

`tests/cli/detect.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../../src/cli/detect.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

async function projectDir(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("laneyard-detect-");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

describe("detectProject", () => {
  it("finds the fastlane folder at the root", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "lane :beta do\nend\n" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBe("fastlane");
  });

  it("finds a fastlane folder nested in a monorepo", async () => {
    const dir = await projectDir({ "apps/ios/fastlane/Fastfile": "lane :beta do\nend\n" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBe("apps/ios/fastlane");
  });

  it("reports the absence of fastlane rather than guessing", async () => {
    const dir = await projectDir({ "README.md": "nothing" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBeNull();
  });

  it("chooses bundle when a Gemfile is present, system otherwise", async () => {
    const withGemfile = await projectDir({ "fastlane/Fastfile": "", Gemfile: 'gem "fastlane"' });
    expect((await detectProject(withGemfile)).runtime).toBe("bundle");

    const without = await projectDir({ "fastlane/Fastfile": "" });
    expect((await detectProject(without)).runtime).toBe("system");
  });

  it("proposes iOS artifact patterns on an Xcode project", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "", "Sample.xcodeproj/project.pbxproj": "" });
    const d = await detectProject(dir);
    expect(d.artifactGlobs).toContain("**/*.ipa");
    expect(d.artifactGlobs.some((g) => g.includes("dSYM"))).toBe(true);
  });

  it("proposes Android patterns on a Gradle project", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "", "app/build.gradle": "" });
    const d = await detectProject(dir);
    expect(d.artifactGlobs).toContain("**/*.apk");
    expect(d.artifactGlobs).toContain("**/*.aab");
  });

  it("reads the remote's URL and the current branch", async () => {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "" });
    const clone = await tmpDir("laneyard-clone-");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["clone", origin, clone]);

    const d = await detectProject(clone);
    expect(d.gitUrl).toBe(origin);
    expect(d.defaultBranch).toBe("main");
  });

  it("derives a slug from the folder name", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "" });
    const d = await detectProject(dir);
    expect(d.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- tests/cli/detect.test.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement the detection**

`src/cli/detect.ts`:

```ts
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { glob } from "tinyglobby";

const exec = promisify(execFile);

export interface Detection {
  slug: string;
  gitUrl: string | null;
  defaultBranch: string;
  /** Relative path of the folder containing the Fastfile, or null if not found. */
  fastlaneDir: string | null;
  runtime: "bundle" | "system";
  artifactGlobs: string[];
  platform: "ios" | "android" | "unknown";
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const gitOr = async (args: string[], cwd: string, fallback: string | null): Promise<string | null> => {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout.trim() || fallback;
  } catch {
    return fallback;
  }
};

/** A folder name isn't a slug: normalize it, but never fail. */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "project" : s;
}

/**
 * Inspects an existing project and proposes a configuration.
 *
 * Decides nothing irreversible: everything it returns is a proposal the
 * user sees and can correct before it's written.
 */
export async function detectProject(dir: string): Promise<Detection> {
  // The Fastfile can be at the root or under a subfolder, for monorepos.
  const fastfiles = await glob(["fastlane/Fastfile", "*/fastlane/Fastfile", "*/*/fastlane/Fastfile"], {
    cwd: dir,
    absolute: true,
    onlyFiles: true,
  });
  const fastfile = fastfiles.sort((a, b) => a.length - b.length)[0] ?? null;
  const fastlaneDir = fastfile
    ? relative(dir, join(fastfile, "..")).split(sep).join("/")
    : null;

  const isIos =
    (await glob(["*.xcodeproj", "*.xcworkspace", "*/*.xcodeproj"], { cwd: dir, onlyDirectories: true }))
      .length > 0;
  const isAndroid =
    (await glob(["build.gradle", "build.gradle.kts", "*/build.gradle", "*/build.gradle.kts"], {
      cwd: dir,
      onlyFiles: true,
    })).length > 0;

  const artifactGlobs: string[] = [];
  if (isIos) artifactGlobs.push("**/*.ipa", "**/*.app.dSYM.zip");
  if (isAndroid) artifactGlobs.push("**/*.apk", "**/*.aab");

  return {
    slug: slugify(basename(dir)),
    gitUrl: await gitOr(["remote", "get-url", "origin"], dir, null),
    defaultBranch: (await gitOr(["rev-parse", "--abbrev-ref", "HEAD"], dir, "main")) ?? "main",
    fastlaneDir,
    runtime: (await exists(join(dir, "Gemfile"))) ? "bundle" : "system",
    artifactGlobs,
    platform: isIos ? "ios" : isAndroid ? "android" : "unknown",
  };
}
```

- [ ] **Step 4: Run the detection tests**

Run: `npm test -- tests/cli/detect.test.ts`
Expected: 8 tests passing.

- [ ] **Step 5: Write the writing tests**

`tests/cli/add.test.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addProjectToConfig } from "../../src/cli/add.js";
import { tmpDir } from "../fixtures/repos.js";

const EXISTING = `# My Laneyard configuration
server:
  port: 7890
  password_hash: "scrypt$a$b"   # server password

projects:
  - slug: deja-la
    git_url: git@example.com:a.git
`;

async function configAt(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-add-");
  const path = join(dir, "config.yml");
  await writeFile(path, content, "utf8");
  return path;
}

const entry = {
  slug: "sample-ios",
  name: "Sample iOS",
  git_url: "git@example.com:sample.git",
  default_branch: "main",
  fastlane_dir: "fastlane",
  runtime: "system" as const,
  artifact_globs: ["**/*.ipa"],
};

describe("addProjectToConfig", () => {
  it("adds the project without removing existing projects", async () => {
    const path = await configAt(EXISTING);
    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as { projects: { slug: string }[] };
    expect(parsed.projects.map((p) => p.slug)).toEqual(["deja-la", "sample-ios"]);
  });

  it("preserves the file's comments", async () => {
    const path = await configAt(EXISTING);
    await addProjectToConfig(path, entry);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("# My Laneyard configuration");
    expect(raw).toContain("# server password");
  });

  it("refuses an already-taken slug", async () => {
    const path = await configAt(EXISTING);
    await expect(addProjectToConfig(path, { ...entry, slug: "deja-la" })).rejects.toThrow(/deja-la/);
  });

  it("creates the file and the server section if they don't exist", async () => {
    const dir = await tmpDir("laneyard-add-");
    const path = join(dir, "config.yml");

    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as {
      server: { password_hash: string };
      projects: unknown[];
    };
    expect(parsed.projects).toHaveLength(1);
    // A password must exist, otherwise the server would refuse every connection.
    expect(parsed.server.password_hash).toMatch(/^scrypt\$/);
  });

  it("adds a projects section missing from an existing file", async () => {
    const path = await configAt('server:\n  password_hash: "scrypt$a$b"\n');
    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as { projects: unknown[] };
    expect(parsed.projects).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run the tests to confirm they fail**

Run: `npm test -- tests/cli/add.test.ts`
Expected: failure — module not found.

- [ ] **Step 7: Implement the writing and the command**

`src/cli/add.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Document, parseDocument, YAMLSeq } from "yaml";
import { hashPassword } from "../server/auth.js";
import { detectProject } from "./detect.js";

export interface NewProjectEntry {
  slug: string;
  name: string;
  git_url: string;
  default_branch: string;
  fastlane_dir: string;
  runtime: "bundle" | "system";
  artifact_globs: string[];
}

/**
 * Adds a project block to config.yml while preserving the rest of the file.
 *
 * The edit goes through the YAML document rather than a parse/serialize
 * round trip: the user's comments — and the order of their keys — survive.
 * It's the same requirement as for the Fastfile: a hand-written file must
 * never come back out damaged.
 */
export async function addProjectToConfig(path: string, entry: NewProjectEntry): Promise<void> {
  let doc: Document.Parsed | Document;
  try {
    doc = parseDocument(await readFile(path, "utf8"));
  } catch {
    doc = new Document({});
  }
  if (doc.contents === null) doc = new Document({});

  if (!doc.hasIn(["server", "password_hash"])) {
    // A server with no password would refuse every connection: we generate one
    // and print it once, leaving it to the caller to note it down.
    const generated = randomBytes(9).toString("base64url");
    doc.setIn(["server", "password_hash"], hashPassword(generated));
    process.stdout.write(`\nGenerated password: ${generated}\n  (write it down, it won't be shown again)\n`);
  }

  const projects = doc.getIn(["projects"]);
  const seq = projects instanceof YAMLSeq ? projects : new YAMLSeq();
  if (!(projects instanceof YAMLSeq)) doc.setIn(["projects"], seq);

  for (const item of seq.items) {
    const slug = (item as { get?: (k: string) => unknown }).get?.("slug");
    if (slug === entry.slug) {
      throw new Error(`A project already uses the slug "${entry.slug}" in ${path}`);
    }
  }

  seq.add(doc.createNode(entry));
  await writeFile(path, doc.toString(), "utf8");
}

/** Entry point for `laneyard add`. */
export async function runAddCommand(cwd: string, configPath: string, slugOverride?: string): Promise<number> {
  const d = await detectProject(cwd);

  if (d.fastlaneDir === null) {
    process.stderr.write(
      "No Fastfile found here. Laneyard drives fastlane: run the command from a project " +
        "that already uses it, or run `fastlane init` first.\n",
    );
    return 1;
  }
  if (d.gitUrl === null) {
    process.stderr.write(
      "No git remote named \"origin\". Laneyard clones projects from their repository: " +
        "add a remote, or set git_url by hand in config.yml.\n",
    );
    return 1;
  }

  const slug = slugOverride ?? d.slug;
  await addProjectToConfig(configPath, {
    slug,
    name: slug,
    git_url: d.gitUrl,
    default_branch: d.defaultBranch,
    fastlane_dir: d.fastlaneDir,
    runtime: d.runtime,
    artifact_globs: d.artifactGlobs,
  });

  process.stdout.write(
    `\nProject "${slug}" added to ${configPath}\n` +
      `  repository   ${d.gitUrl} (${d.defaultBranch})\n` +
      `  fastlane     ${d.fastlaneDir}\n` +
      `  runtime      ${d.runtime}\n` +
      `  artifacts    ${d.artifactGlobs.join(", ") || "no pattern detected — fill in manually"}\n` +
      `\nRestart Laneyard or wait for the automatic reload, the project will appear in the interface.\n`,
  );
  return 0;
}
```

In `src/main.ts`, dispatch before starting the server:

```ts
const [, , command, ...rest] = process.argv;
if (command === "add") {
  const home = process.env["LANEYARD_HOME"] ?? join(homedir(), ".laneyard");
  await mkdir(home, { recursive: true });
  const slugIndex = rest.indexOf("--slug");
  const slug = slugIndex === -1 ? undefined : rest[slugIndex + 1];
  process.exit(await runAddCommand(process.cwd(), join(home, "config.yml"), slug));
}
```

And in `package.json`:

```json
"bin": { "laneyard": "dist/src/main.js" }
```

- [ ] **Step 8: Run the tests**

Run: `npm test -- tests/cli/`
Expected: 13 tests passing.

- [ ] **Step 9: Verify on a real project**

From an existing mobile project that uses fastlane:

```bash
LANEYARD_HOME=/tmp/laneyard-demo npx tsx /path/to/laneyard/src/main.ts add
```

Verify that `/tmp/laneyard-demo/config.yml` contains a coherent block, that the generated password
is shown once, and that a second run refuses the duplicate slug.

- [ ] **Step 10: Commit**

```bash
git add src/cli tests/cli src/main.ts package.json
git commit -m "feat(cli): add command to adopt an existing fastlane project"
```

---

## What milestone 1 deliberately leaves out

To be handled in the following plans, in this order:

- **Milestone 2 — reliability**: secret redaction with a sliding buffer, queue and global limit,
  cancellation from the interface, orphaned-run purge at startup exposed in the UI.
- **Milestone 3 — secrets and CI Readiness**: encrypted vault, injection into the run's
  environment, the `src/heuristics/` module, the five checklist items.
- **Milestone 4 — editor**: the sidecar's `actions` and `parse` commands, text editor with
  verification, then the structured view and surgical rewriting.
- **Milestone 5 — polish and publishing**: notifications, purge, light theme, service
  installation, README, CONTRIBUTING, license.

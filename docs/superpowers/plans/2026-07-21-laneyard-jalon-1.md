# Laneyard — Jalon 1 : le fil complet

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Déclarer un projet dans `config.yml`, le cloner, lister ses lanes, en lancer une, suivre sa sortie en direct dans le navigateur et télécharger l'artefact produit.

**Architecture:** Serveur Fastify en TypeScript. La configuration vit dans des fichiers YAML, jamais en base ; SQLite ne garde que l'état d'exécution. Toute connaissance de fastlane vient d'un script Ruby lancé dans le bundle du projet, qui renvoie du JSON. Les runs s'exécutent dans un pseudo-terminal, leur sortie part simultanément vers un fichier de log et vers les navigateurs connectés par WebSocket.

**Tech Stack:** Node 22+ / TypeScript ESM · Fastify 5 · better-sqlite3 · node-pty · zod · yaml · tinyglobby · Vitest · React 19 + Vite · Ruby avec Prism (inclus depuis Ruby 3.3)

**Spec de référence:** `docs/superpowers/specs/2026-07-21-laneyard-design.md`

**Hors périmètre de ce plan** (jalons 2 à 5) : caviardage des secrets, coffre, file d'attente, annulation, timeout, Préparation CI, éditeur de Fastfile, notifications, purge, thèmes, README.

---

## Structure des fichiers

```
src/
  config/
    schema.ts        Schémas zod de config.yml et laneyard.yml, types dérivés
    load.ts          Lecture + validation d'un fichier YAML → objet typé ou erreur
    resolve.ts       Fusion laneyard.yml > bloc projet > défauts, avec provenance
    store.ts         État vivant de la config : chargement, surveillance, accès
  db/
    schema.sql       DDL des tables
    open.ts          Ouverture, migrations, pragmas
    runs.ts          Lecture/écriture des runs, étapes et artefacts
    cache.ts         Cache d'introspection
  git/
    workspace.ts     Clone initial, fetch, checkout, SHA courant, état sale
  sidecar/
    bridge.ts        Invocation du script Ruby, parsing du JSON, erreurs typées
    lanes.ts         Lecture des lanes avec cache indexé sur l'empreinte du fastlane_dir
  logs/
    store.ts         Écriture append-only et lecture depuis un décalage
  heuristics/
    error-summary.ts Extraction d'une cause d'échec lisible — connaissance nommée, isolée
  runner/
    pty.ts           Lancement d'un processus dans un PTY, flux de sortie, code de sortie
    live-steps.ts    Repérage des séparateurs d'étape et de leur décalage en octets
    report.ts        Lecture de fastlane/report.xml
    artifacts.ts     Collecte par motifs
    orchestrate.ts   Enchaînement complet d'un run et transitions d'état
  sidecar/
    ruby-env.ts      Résolution d'un environnement Ruby capable de charger fastlane
  cli/
    detect.ts        Inspection d'un projet existant : fastlane, plateforme, git
    add.ts           Écriture du bloc projet dans config.yml, commentaires préservés
  server/
    app.ts           Construction de l'instance Fastify
    auth.ts          Session par cookie, mot de passe scrypt
    ws.ts            Diffusion des fragments de log par run
    routes/
      projects.ts    Liste des projets, lanes d'un projet
      runs.ts        Déclenchement, consultation, log, artefacts
  main.ts            Point d'entrée : charge la config, ouvre la base, démarre
ruby/
  introspect.rb      Sidecar : commandes lanes / actions / parse
web/                 Application React (Vite)
tests/
  fixtures/
    fake-fastlane/   Faux exécutable rejouant une sortie enregistrée
    repos/           Générateurs de dépôts git de test
```

Chaque module expose des fonctions pures autant que possible ; les entrées/sorties (fichiers,
processus, base) sont concentrées dans `store.ts`, `open.ts`, `pty.ts` et `workspace.ts`, ce qui
rend le reste testable sans machine de build.

---

### Task 1 : Squelette du projet

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/main.ts`, `tests/smoke.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/smoke.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { version } from "../src/main.js";

describe("laneyard", () => {
  it("expose sa version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `npm test`
Expected: échec — le module `src/main.ts` n'existe pas.

- [ ] **Step 3 : Créer le squelette**

`package.json` :

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

> `tsx` plutôt que `node --experimental-strip-types` : le retrait de types natif ne réécrit pas les
> spécificateurs `./x.js` vers `./x.ts`, or c'est la forme qu'impose `moduleResolution: NodeNext`.

`tsconfig.json` :

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

`vitest.config.ts` :

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
```

`.gitignore` — ajouter aux lignes existantes :

```
node_modules/
dist/
*.db
```

`src/main.ts` :

```ts
export const version = "0.1.0";
```

- [ ] **Step 4 : Installer et vérifier que le test passe**

Run: `npm install && npm test`
Expected: 1 test passé. `better-sqlite3` et `node-pty` compilent des modules natifs — si
l'installation échoue, vérifier que les outils de compilation C++ sont présents.

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "chore: squelette TypeScript, Vitest et dépendances"
```

---

### Task 2 : Schéma et chargement de la configuration serveur

**Files:**
- Create: `src/config/schema.ts`, `src/config/load.ts`, `tests/config/load.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/config/load.test.ts` :

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
  - slug: popotes-ios
    git_url: git@github.com:martin/popotes.git
`;

describe("loadServerConfig", () => {
  it("applique les valeurs par défaut du serveur", async () => {
    const res = await loadServerConfig(await withConfig(minimal));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.server.port).toBe(7890);
    expect(res.config.server.bind).toBe("0.0.0.0");
    expect(res.config.server.max_concurrent_runs).toBe(1);
    expect(res.config.server.retention).toEqual({ runs: 50, artifact_days: 30 });
  });

  it("déduit le nom d'un projet depuis son slug", async () => {
    const res = await loadServerConfig(await withConfig(minimal));
    if (!res.ok) throw new Error("attendu valide");
    expect(res.config.projects[0]!.name).toBe("popotes-ios");
    expect(res.config.projects[0]!.default_branch).toBe("main");
  });

  it("refuse deux projets partageant le même slug", async () => {
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

  it("refuse un slug qui n'est pas utilisable dans un chemin", async () => {
    const res = await loadServerConfig(
      await withConfig(`
server: { password_hash: "x" }
projects:
  - { slug: "../evil", git_url: u }
`),
    );
    expect(res.ok).toBe(false);
  });

  it("rapporte une erreur lisible sur un YAML invalide", async () => {
    const res = await loadServerConfig(await withConfig("server: {"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.length).toBeGreaterThan(0);
  });

  it("rapporte un fichier absent sans lever d'exception", async () => {
    const res = await loadServerConfig("/nexiste/pas/config.yml");
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/config/load.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Écrire le schéma et le chargeur**

`src/config/schema.ts` :

```ts
import { z } from "zod";

/** Réglages de comportement de build. Ils peuvent venir du dépôt ou du serveur. */
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

/** Même vocabulaire, mais tout est facultatif dans les fichiers. */
export const projectSettingsInputSchema = projectSettingsSchema.partial();

/** Un slug sert de nom de dossier et de segment d'URL. */
const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug : minuscules, chiffres et tirets uniquement");

export const projectEntrySchema = projectSettingsInputSchema.extend({
  slug: slugSchema,
  name: z.string().optional(),
  git_url: z.string().min(1),
  default_branch: z.string().default("main"),
  git_auth: z
    .object({
      kind: z.enum(["none", "ssh_key", "token"]),
      /** Chemin de fichier si kind vaut ssh_key, nom de secret si kind vaut token. */
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

/** Contenu de laneyard.yml : uniquement du comportement de build. */
export const repoConfigSchema = projectSettingsInputSchema;

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema> & { name: string };
export type ServerConfig = Omit<z.infer<typeof serverConfigSchema>, "projects"> & {
  projects: ProjectEntry[];
};
export type RepoConfig = z.infer<typeof repoConfigSchema>;
```

`src/config/load.ts` :

```ts
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import { repoConfigSchema, serverConfigSchema } from "./schema.js";
import type { RepoConfig, ServerConfig } from "./schema.js";

export type LoadResult<T> = { ok: true; config: T } | { ok: false; error: string };

/** Lit et valide un fichier YAML. N'échoue jamais par exception : l'appelant décide. */
// `ZodType<T, any, any>` et non `ZodType<T>` : sur un schéma comportant des `.default()`,
// le type d'entrée diffère du type de sortie, et TypeScript infère alors `T` sur l'entrée
// — donc avec des champs optionnels. Neutraliser les deux derniers paramètres force
// l'inférence sur la sortie, seule pertinente ici.
async function loadYamlFile<T>(path: string, schema: ZodType<T, any, any>): Promise<LoadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    return { ok: false, error: `Lecture impossible de ${path} : ${(cause as Error).message}` };
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (cause) {
    return { ok: false, error: `YAML invalide dans ${path} : ${(cause as Error).message}` };
  }

  const parsed = schema.safeParse(data ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`)
      .join(" ; ");
    return { ok: false, error: `Configuration invalide dans ${path} — ${details}` };
  }
  return { ok: true, config: parsed.data };
}

export async function loadServerConfig(path: string): Promise<LoadResult<ServerConfig>> {
  const res = await loadYamlFile(path, serverConfigSchema);
  if (!res.ok) return res;

  const seen = new Set<string>();
  for (const p of res.config.projects) {
    if (seen.has(p.slug)) {
      return { ok: false, error: `Configuration invalide dans ${path} — slug en double : ${p.slug}` };
    }
    seen.add(p.slug);
  }

  // Le nom affiché retombe sur le slug plutôt que d'être optionnel partout en aval.
  const projects = res.config.projects.map((p) => ({ ...p, name: p.name ?? p.slug }));
  return { ok: true, config: { ...res.config, projects } };
}

export async function loadRepoConfig(path: string): Promise<LoadResult<RepoConfig>> {
  return loadYamlFile(path, repoConfigSchema);
}
```

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/config/load.test.ts`
Expected: 6 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/config tests/config
git commit -m "feat(config): schéma et chargement de config.yml"
```

---

### Task 3 : Résolution de la configuration d'un projet

La précédence décrite dans la spec — `laneyard.yml` du dépôt, puis le bloc du projet, puis les
défauts — avec la provenance de chaque champ, que l'interface affichera plus tard.

**Files:**
- Create: `src/config/resolve.ts`, `tests/config/resolve.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/config/resolve.test.ts` :

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
  it("retombe sur les défauts quand rien n'est défini", () => {
    const r = resolveProjectSettings(entry(), null);
    expect(r.settings.fastlane_dir).toBe("fastlane");
    expect(r.settings.timeout_minutes).toBe(60);
    expect(r.provenance.fastlane_dir).toBe("default");
  });

  it("le bloc du projet l'emporte sur les défauts", () => {
    const r = resolveProjectSettings(entry({ timeout_minutes: 15 }), null);
    expect(r.settings.timeout_minutes).toBe(15);
    expect(r.provenance.timeout_minutes).toBe("server");
  });

  it("le dépôt l'emporte sur le bloc du projet", () => {
    const r = resolveProjectSettings(entry({ timeout_minutes: 15 }), { timeout_minutes: 90 });
    expect(r.settings.timeout_minutes).toBe(90);
    expect(r.provenance.timeout_minutes).toBe("repo");
  });

  it("mélange les provenances champ par champ", () => {
    const r = resolveProjectSettings(entry({ runtime: "system" }), {
      artifact_globs: ["build/*.ipa"],
    });
    expect(r.settings.runtime).toBe("system");
    expect(r.provenance.runtime).toBe("server");
    expect(r.settings.artifact_globs).toEqual(["build/*.ipa"]);
    expect(r.provenance.artifact_globs).toBe("repo");
    expect(r.provenance.fastlane_dir).toBe("default");
  });

  it("traite un tableau vide comme une valeur définie, pas comme une absence", () => {
    const r = resolveProjectSettings(entry(), { artifact_globs: [] });
    expect(r.provenance.artifact_globs).toBe("repo");
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/config/resolve.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter la résolution**

`src/config/resolve.ts` :

```ts
import { projectSettingsSchema } from "./schema.js";
import type { ProjectEntry, ProjectSettings, RepoConfig } from "./schema.js";

export type Origin = "repo" | "server" | "default";
export type Provenance = Record<keyof ProjectSettings, Origin>;

const SETTING_KEYS = Object.keys(projectSettingsSchema.shape) as (keyof ProjectSettings)[];

/**
 * Fusionne les trois sources champ par champ.
 * `undefined` signifie « non défini » ; toute autre valeur, y compris un tableau vide
 * ou `false`, est une décision explicite de l'utilisateur.
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

  // Le schéma applique les défauts pour tout ce qui reste absent.
  const settings = projectSettingsSchema.parse(chosen);
  return { settings, provenance };
}
```

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/config/resolve.test.ts`
Expected: 5 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/config/resolve.ts tests/config/resolve.test.ts
git commit -m "feat(config): résolution avec précédence et provenance"
```

---

### Task 4 : Base de données et accès aux runs

**Files:**
- Create: `src/db/schema.sql`, `src/db/open.ts`, `src/db/runs.ts`, `tests/db/runs.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/db/runs.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";

function store(): RunStore {
  return new RunStore(openDatabase(":memory:"));
}

describe("RunStore", () => {
  it("crée un run en attente et le relit", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "beta", platform: "ios", params: { v: "1.2" } });
    const run = s.get(id);
    expect(run?.status).toBe("queued");
    expect(run?.params).toEqual({ v: "1.2" });
    expect(run?.startedAt).toBeNull();
  });

  it("horodate le passage à running et à un état terminal", () => {
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

  it("liste les runs d'un projet du plus récent au plus ancien", () => {
    const s = store();
    const a = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    const b = s.create({ projectSlug: "p", lane: "b", platform: null, params: {} });
    s.create({ projectSlug: "autre", lane: "c", platform: null, params: {} });
    expect(s.listByProject("p").map((r) => r.id)).toEqual([b, a]);
  });

  it("marque interrompu tout run resté actif", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    s.markRunning(id, { branch: "main", commitSha: "x" });
    expect(s.interruptActive()).toBe(1);
    expect(s.get(id)?.status).toBe("interrupted");
    expect(s.interruptActive()).toBe(0);
  });

  it("enregistre étapes et artefacts rattachés au run", () => {
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

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/db/runs.test.ts`
Expected: échec — modules introuvables.

- [ ] **Step 3 : Écrire le schéma et le magasin**

`src/db/schema.sql` :

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

`src/db/open.ts` :

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

> Le fichier `schema.sql` doit être copié à côté du JS compilé — le script `build` de la tâche 1
> s'en charge déjà. En développement, `tsx` exécute les sources : le chemin est correct sans rien
> faire.

`src/db/runs.ts` :

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

/** Un run est actif tant qu'il n'a pas atteint un état terminal. */
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

  /** Au démarrage : aucun run ne peut être en cours, le processus qui le portait est mort. */
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

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/db/runs.test.ts`
Expected: 5 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/db tests/db
git commit -m "feat(db): schéma SQLite et magasin des runs"
```

---

### Task 5 : Gestion du workspace git

**Files:**
- Create: `src/git/workspace.ts`, `tests/fixtures/repos.ts`, `tests/git/workspace.test.ts`

- [ ] **Step 1 : Écrire l'aide de test et les tests qui échouent**

`tests/fixtures/repos.ts` :

```ts
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Crée un dépôt git local servant de « distant » dans les tests. */
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

`tests/git/workspace.test.ts` :

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../../src/git/workspace.js";
import { commitTo, makeOriginRepo, tmpDir } from "../fixtures/repos.js";

describe("Workspace", () => {
  it("clone au premier accès puis se déclare prêt", async () => {
    const origin = await makeOriginRepo({ "README.md": "hello" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);

    expect(await ws.exists()).toBe(false);
    await ws.prepare("main");
    expect(await ws.exists()).toBe(true);
    expect(await readFile(join(ws.path, "README.md"), "utf8")).toBe("hello");
  });

  it("récupère les nouveaux commits au run suivant", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");

    const sha = await commitTo(origin, "a.txt", "v2");
    await ws.prepare("main");

    expect(await readFile(join(ws.path, "a.txt"), "utf8")).toBe("v2");
    expect(await ws.headSha()).toBe(sha);
  });

  it("refuse de préparer par-dessus des modifications non commitées", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");
    await writeFile(join(ws.path, "a.txt"), "modifié à la main", "utf8");

    expect(await ws.isDirty()).toBe(true);
    await expect(ws.prepare("main")).rejects.toThrow(/non commit/i);
  });

  it("échoue lisiblement sur une branche inconnue", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await expect(ws.prepare("nexiste-pas")).rejects.toThrow(/nexiste-pas/);
  });

  it("clone à la demande sans basculer de branche", async () => {
    const origin = await makeOriginRepo({ "laneyard.yml": "runtime: system\n" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);

    await ws.ensureCloned();
    expect(await ws.exists()).toBe(true);

    // Idempotent : un second appel ne refait rien et ne lève pas.
    await ws.ensureCloned();
    expect(await ws.exists()).toBe(true);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/git/workspace.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter le workspace**

`src/git/workspace.ts` :

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
 * Un clone géré par Laneyard, conservé entre les runs.
 * Toutes les commandes git passent par ici pour partager l'environnement d'authentification.
 */
export class Workspace {
  constructor(
    readonly path: string,
    private readonly gitUrl: string,
    private readonly auth: GitAuth = { kind: "none" },
  ) {}

  private env(): NodeJS.ProcessEnv {
    // Sans cela, git peut bloquer sur une demande d'identifiants et figer le run.
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
      throw new Error(`git ${args.join(" ")} a échoué : ${(err.stderr || err.message).trim()}`);
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
   * Vrai s'il existe des modifications *suivies* non commitées.
   *
   * Les fichiers non suivis sont volontairement ignorés : un build en sème
   * (fastlane réécrit `fastlane/README.md` à chaque exécution, les artefacts
   * atterrissent dans `build/`), et surtout `git checkout` ne les détruit pas.
   * Les compter rendrait tout second run impossible sans protéger quoi que ce soit.
   */
  async isDirty(): Promise<boolean> {
    if (!(await this.exists())) return false;
    return (await this.git(["status", "--porcelain", "--untracked-files=no"])) !== "";
  }

  async headSha(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  /**
   * Garantit la présence du clone, sans toucher à la branche courante.
   *
   * Nécessaire avant toute lecture du dépôt hors run — lister les lanes, lire le
   * laneyard.yml — puisque ces informations vivent dans les fichiers du projet.
   */
  async ensureCloned(onProgress?: (line: string) => void): Promise<void> {
    if (await this.exists()) return;
    onProgress?.(`Clonage de ${this.gitUrl}…`);
    await this.git(["clone", this.gitUrl, this.path], process.cwd());
  }

  /**
   * Amène le workspace sur la branche demandée, à jour.
   * Clone au premier appel, se contente d'un fetch ensuite.
   */
  async prepare(branch: string, onProgress?: (line: string) => void): Promise<string> {
    if (!(await this.exists())) {
      await this.ensureCloned(onProgress);
    } else {
      if (await this.isDirty()) {
        throw new Error(
          "Le workspace contient des modifications non commitées. " +
            "Committez-les ou nettoyez le workspace avant de lancer un run.",
        );
      }
      onProgress?.("Récupération des nouveautés…");
      await this.git(["fetch", "--prune", "origin"]);
    }

    onProgress?.(`Bascule sur ${branch}…`);
    await this.git(["checkout", "-q", "-B", branch, `origin/${branch}`]);
    return this.headSha();
  }
}
```

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/git/workspace.test.ts`
Expected: 5 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/git tests/git tests/fixtures/repos.ts
git commit -m "feat(git): clone, fetch et checkout du workspace"
```

---

### Task 6 : Sidecar Ruby — commande `lanes`

**Files:**
- Create: `src/sidecar/ruby-env.ts`, `tests/sidecar/ruby-env.test.ts`, `ruby/introspect.rb`, `tests/ruby/introspect.test.ts`

#### Pourquoi un résolveur d'environnement Ruby

Le sidecar suppose que `require "fastlane"` fonctionne. Ce n'est vrai que si fastlane est un gem
visible du Ruby courant. Or l'installation la plus répandue sur macOS, celle d'Homebrew, place
fastlane dans un `GEM_HOME` privé et fournit un lanceur qui le positionne avant d'exécuter :

```bash
GEM_HOME="${HOME}/.local/share/fastlane/4.0.0" exec ".../libexec/bin/fastlane" "$@"
```

Avec ce type d'installation, `ruby -e 'require "fastlane"'` échoue. Le mode `system` serait donc
inutilisable sans que rien n'explique pourquoi. En mode `bundle`, `bundle exec` règle la question
seul — le problème ne concerne que `system`.

La résolution procède par essais, du plus simple au plus spécifique, et le résultat est mémorisé :

1. l'environnement courant, qui suffit dès que fastlane est installé normalement (`gem install`,
   rbenv, rvm, asdf) ;
2. à défaut, l'environnement extrait du lanceur `fastlane` s'il s'agit d'un script shell — cas
   Homebrew ;
3. sinon, un échec explicite disant quoi faire.

- [ ] **Step 1 : Écrire les tests du résolveur**

`tests/sidecar/ruby-env.test.ts` :

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveRubyEnv } from "../../src/sidecar/ruby-env.js";

const exec = promisify(execFile);

describe("resolveRubyEnv", () => {
  it("rend un environnement où Ruby sait charger fastlane", async () => {
    const resolved = await resolveRubyEnv();
    expect(resolved).not.toBeNull();

    const { stdout } = await exec("ruby", ["-e", 'require "fastlane"; print "ok"'], {
      env: resolved!.env,
      timeout: 180_000,
    });
    expect(stdout).toBe("ok");
  }, 240_000);

  it("indique d'où vient l'environnement retenu", async () => {
    const resolved = await resolveRubyEnv();
    expect(["process", "launcher"]).toContain(resolved!.source);
  }, 240_000);

  it("mémorise le résultat plutôt que de resonder à chaque appel", async () => {
    const a = await resolveRubyEnv();
    const b = await resolveRubyEnv();
    expect(b).toBe(a);
  }, 240_000);
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/sidecar/ruby-env.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter le résolveur**

`src/sidecar/ruby-env.ts` :

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RubyEnv {
  env: NodeJS.ProcessEnv;
  /** `process` : Ruby savait déjà. `launcher` : environnement repris du lanceur fastlane. */
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
 * Reconstitue l'environnement du lanceur `fastlane` quand c'en est un script shell.
 *
 * On n'exécute pas le lanceur : on relit ses affectations `GEM_HOME` et `GEM_PATH`
 * et on les fait évaluer par bash, qui sait développer `${HOME}` et les valeurs par
 * défaut. Approche volontairement étroite — deux variables, rien d'autre.
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
 * Trouve un environnement dans lequel `ruby` peut charger fastlane, ou null.
 *
 * Le résultat est mémorisé : sonder coûte plusieurs secondes, fastlane étant lent
 * à charger, et l'installation ne change pas en cours d'exécution.
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

/** Message unique, pour ne pas décrire le problème différemment à chaque endroit. */
export const FASTLANE_UNAVAILABLE =
  "Ruby ne parvient pas à charger fastlane. Installez-le pour le Ruby courant " +
  "(`gem install fastlane`), ou déclarez un Gemfile dans le projet et passez le " +
  "réglage `runtime` à `bundle`.";
```

- [ ] **Step 4 : Lancer les tests du résolveur**

Run: `npm test -- tests/sidecar/ruby-env.test.ts`
Expected: 3 tests passés. Le premier appel prend plusieurs secondes — fastlane est lent à charger.

- [ ] **Step 5 : Écrire les tests du sidecar**

`tests/ruby/introspect.test.ts` :

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
  // Le sidecar tourne ici sans bundle : il lui faut l'environnement résolu.
  const ruby = await resolveRubyEnv();
  if (!ruby) throw new Error("fastlane introuvable pour le Ruby courant");

  const { stdout } = await exec("ruby", [SCRIPT, cmd, "--fastlane-dir", "fastlane"], {
    cwd: dir,
    env: ruby.env,
    timeout: 180_000,
  });
  return JSON.parse(stdout);
}

describe("introspect.rb lanes", () => {
  it("liste les lanes avec plateforme et description", async () => {
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

  it("renvoie une erreur structurée sur un Fastfile invalide", async () => {
    const dir = await projectWithFastfile("lane :beta do\n  # jamais fermé\n");
    const res = (await introspect(dir, "lanes")) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error.length).toBeGreaterThan(0);
  }, 180_000);
});
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `npm test -- tests/ruby/introspect.test.ts`
Expected: échec — `ruby/introspect.rb` n'existe pas.

- [ ] **Step 3 : Écrire le sidecar**

`ruby/introspect.rb` :

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Sidecar d'introspection de Laneyard.
#
# Lancé dans le dossier d'un projet — idéalement via `bundle exec` — il est le seul
# composant qui connaît fastlane. Il n'écrit jamais rien : il lit et renvoie du JSON
# sur la sortie standard.
#
#   ruby introspect.rb lanes   --fastlane-dir fastlane
#   ruby introspect.rb actions --fastlane-dir fastlane
#   ruby introspect.rb parse   --fastlane-dir fastlane
#
# Le contrat de sortie est constant : { "ok": true, ... } ou { "ok": false, "error": "..." }.
# Une erreur est une réponse valide, jamais une trace sur stderr.

require "json"

# Voir plus bas : la vraie sortie standard est mise de côté dès le départ pour que
# rien d'autre que notre JSON ne puisse s'y glisser.
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

fail_with("Fastfile introuvable : #{fastfile_path}") unless File.exist?(fastfile_path)

# fastlane écrit volontiers sur la sortie standard — avertissements de plugin,
# messages de dépréciation, bandeau de mise à jour. Un seul de ces messages
# corromprait le JSON attendu par l'appelant. Tout part donc vers l'erreur standard,
# et seule `respond` écrit sur la vraie sortie.
$stdout = $stderr

begin
  require "fastlane"
rescue LoadError => e
  fail_with("fastlane n'est pas disponible dans cet environnement Ruby (#{e.message})")
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
    # Un Fastfile est du Ruby arbitraire : son chargement peut lever n'importe quoi,
    # y compris des erreurs de syntaxe qui ne descendent pas de StandardError.
    fail_with("Chargement du Fastfile impossible : #{e.message}")
  end

  # `respond` se termine par `exit`, qui lève SystemExit — lui aussi un Exception.
  # L'appeler à l'intérieur du bloc protégé ferait attraper sa propre sortie et
  # écrirait un second JSON d'erreur « exit ». Il reste donc dehors.
  respond({ ok: true, lanes: lanes })
else
  fail_with("Commande inconnue : #{command.inspect}")
end
```

- [ ] **Step 4 : Lancer le test**

Run: `npm test -- tests/ruby/introspect.test.ts`
Expected: 2 tests passés. Le premier appel est lent — fastlane met plusieurs secondes à se charger,
d'où le délai de 180 s.

- [ ] **Step 5 : Commit**

```bash
git add ruby tests/ruby src/sidecar tests/sidecar
git commit -m "feat(sidecar): commande lanes du script d'introspection Ruby"
```

---

### Task 7 : Pont TypeScript vers le sidecar, avec cache

**Files:**
- Create: `src/sidecar/bridge.ts`, `src/db/cache.ts`, `src/sidecar/lanes.ts`, `tests/sidecar/lanes.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/sidecar/lanes.test.ts` :

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
  it("interroge le sidecar puis sert le cache au second appel", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: LANES });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    expect(await reader.read("p", dir, "fastlane")).toEqual(LANES);
    expect(await reader.read("p", dir, "fastlane")).toEqual(LANES);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("réinterroge le sidecar quand un fichier du dossier change", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: LANES });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    await reader.read("p", dir, "fastlane");
    await writeFile(join(dir, "fastlane", "Fastfile"), "lane :beta do\n  puts 1\nend\n", "utf8");
    await reader.read("p", dir, "fastlane");

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("réinterroge aussi quand un fichier voisin change, pas seulement le Fastfile", async () => {
    const dir = await fastlaneDir({ Fastfile: "lane :beta do\nend\n", Appfile: "app_identifier 'a'\n" });
    const invoke = vi.fn().mockResolvedValue({ ok: true, lanes: LANES });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    await reader.read("p", dir, "fastlane");
    await writeFile(join(dir, "fastlane", "Appfile"), "app_identifier 'b'\n", "utf8");
    await reader.read("p", dir, "fastlane");

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("propage l'erreur du sidecar sans rien mettre en cache", async () => {
    const dir = await fastlaneDir({ Fastfile: "cassé" });
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: "Fastfile illisible" });
    const reader = new LaneReader(new CacheStore(openDatabase(":memory:")), invoke);

    await expect(reader.read("p", dir, "fastlane")).rejects.toThrow(/illisible/);
    await expect(reader.read("p", dir, "fastlane")).rejects.toThrow(/illisible/);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/sidecar/lanes.test.ts`
Expected: échec — modules introuvables.

- [ ] **Step 3 : Implémenter le pont, le cache et le lecteur**

`src/sidecar/bridge.ts` :

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
 * Lance le sidecar dans le contexte du projet.
 * En mode `bundle`, l'invocation passe par `bundle exec` pour voir la bonne version
 * de fastlane et les plugins déclarés par le projet.
 */
export function makeInvoke(runtime: "bundle" | "system"): Invoke {
  return async (command, cwd, fastlaneDir) => {
    const [bin, args] =
      runtime === "bundle"
        ? ["bundle", ["exec", "ruby", SCRIPT, command, "--fastlane-dir", fastlaneDir]]
        : ["ruby", [SCRIPT, command, "--fastlane-dir", fastlaneDir]];

    // En mode bundle, `bundle exec` fournit déjà le bon environnement. En mode
    // system, il faut le trouver : selon l'installation, `ruby` ne voit pas fastlane.
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
        error: `Le sidecar Ruby a échoué : ${(err.stderr || err.message).trim()}`,
      };
    }
  };
}
```

`src/db/cache.ts` :

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

`src/sidecar/lanes.ts` :

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
 * Empreinte de tout le dossier fastlane, pas seulement du Fastfile :
 * un Appfile, un Pluginfile ou un fichier importé changent les lanes tout autant.
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

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/sidecar/lanes.test.ts`
Expected: 4 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/sidecar src/db/cache.ts tests/sidecar
git commit -m "feat(sidecar): pont TypeScript et cache d'introspection"
```

---

### Task 8 : Magasin de logs

**Files:**
- Create: `src/logs/store.ts`, `tests/logs/store.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/logs/store.test.ts` :

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LogStore } from "../../src/logs/store.js";
import { tmpDir } from "../fixtures/repos.js";

describe("LogStore", () => {
  it("écrit et relit intégralement", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(1);
    await w.append("première ligne\n");
    await w.append("seconde ligne\n");
    await w.close();

    expect(await store.read(1)).toBe("première ligne\nseconde ligne\n");
  });

  it("relit depuis un décalage en octets", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(2);
    await w.append("abcdef");
    await w.close();

    expect(await store.read(2, 3)).toBe("def");
  });

  it("expose le décalage courant après chaque écriture", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(3);
    expect(w.offset).toBe(0);
    await w.append("héllo"); // 6 octets en UTF-8, pas 5
    expect(w.offset).toBe(6);
    await w.close();
  });

  it("renvoie une chaîne vide pour un run sans log", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    expect(await store.read(999)).toBe("");
  });

  it("place le fichier dans le dossier configuré", async () => {
    const dir = await tmpDir("laneyard-logs-");
    const store = new LogStore(dir);
    expect(store.pathFor(7)).toBe(join(dir, "7.log"));
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/logs/store.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter le magasin**

`src/logs/store.ts` :

```ts
import { createReadStream } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * Écrivain append-only pour un run.
 * `offset` compte des octets, jamais des caractères : c'est ce que la reprise
 * de lecture côté navigateur manipule, et un accent occupe deux octets.
 */
export class LogWriter {
  private _offset = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly handle: FileHandle) {}

  get offset(): number {
    return this._offset;
  }

  /**
   * Réserve le décalage immédiatement puis sérialise les écritures.
   *
   * Les fragments arrivent d'un PTY, sans attendre : si le décalage était calculé
   * après l'écriture, deux fragments concurrents pourraient s'attribuer la même
   * position et le rattrapage côté navigateur dupliquerait ou perdrait du texte.
   */
  async append(chunk: string): Promise<number> {
    const buf = Buffer.from(chunk, "utf8");
    const start = this._offset;
    this._offset += buf.byteLength;

    this.queue = this.queue.then(() => this.handle.write(buf)).catch(() => {
      // Le fichier a pu être fermé pendant que le processus finissait de parler.
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

  /** Pour servir un gros log sans le charger entièrement en mémoire. */
  stream(runId: number, fromOffset = 0): NodeJS.ReadableStream {
    return createReadStream(this.pathFor(runId), { start: fromOffset });
  }
}
```

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/logs/store.test.ts`
Expected: 5 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/logs tests/logs
git commit -m "feat(logs): écriture append-only et lecture depuis un décalage"
```

---

### Task 9 : Repérage des étapes en direct et lecture de report.xml

**Files:**
- Create: `src/runner/live-steps.ts`, `src/runner/report.ts`, `tests/runner/live-steps.test.ts`, `tests/runner/report.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/runner/live-steps.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { LiveStepTracker } from "../../src/runner/live-steps.js";

describe("LiveStepTracker", () => {
  it("repère une étape et retient son décalage", () => {
    const t = new LiveStepTracker();
    t.consume("[09:41:02]: bruit avant\n", 0);
    t.consume("[09:41:03]: ------ Step: build_app ------\n", 30);
    expect(t.steps()).toEqual([{ name: "build_app", logOffset: 30 }]);
  });

  it("repère plusieurs étapes dans l'ordre d'apparition", () => {
    const t = new LiveStepTracker();
    t.consume("[t]: --- Step: match ---\n[t]: --- Step: build_app ---\n", 100);
    expect(t.steps().map((s) => s.name)).toEqual(["match", "build_app"]);
    expect(t.steps()[0]!.logOffset).toBe(100);
    expect(t.steps()[1]!.logOffset).toBeGreaterThan(100);
  });

  it("recolle une ligne coupée entre deux fragments", () => {
    const t = new LiveStepTracker();
    t.consume("[t]: ------ Step: buil", 0);
    t.consume("d_app ------\n", 17);
    expect(t.steps().map((s) => s.name)).toEqual(["build_app"]);
  });

  it("ignore une ligne qui mentionne Step sans être un séparateur", () => {
    const t = new LiveStepTracker();
    t.consume("Le mot Step: apparaît ici sans tirets\n", 0);
    expect(t.steps()).toEqual([]);
  });
});
```

`tests/runner/report.test.ts` :

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readReport } from "../../src/runner/report.js";
import { tmpDir } from "../fixtures/repos.js";

// Forme réelle observée : les actions réussies sont auto-fermantes.
const OK = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="fastlane.lanes">
    <testcase classname="fastlane.lanes" name="0: match" time="11.5"/>
    <testcase classname="fastlane.lanes" name="1: build_app" time="238.25"/>
  </testsuite>
</testsuites>`;

// Rapport mixte : c'est le cas qui piège un motif mal ordonné.
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
  it("extrait nom, index et durée de chaque action", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), OK, "utf8");
    const steps = await readReport(join(dir, "report.xml"));

    expect(steps).toEqual([
      { idx: 0, name: "match", durationMs: 11_500, status: "success" },
      { idx: 1, name: "build_app", durationMs: 238_250, status: "success" },
    ]);
  });

  it("n'attribue l'échec qu'à l'action concernée dans un rapport mixte", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), FAILED, "utf8");
    const steps = await readReport(join(dir, "report.xml"));
    // Restreint le type autant que ça vérifie : la suite indexe le tableau.
    if (!steps) throw new Error("rapport attendu");

    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe("success");
    expect(steps[1]!.name).toBe("build_app");
    expect(steps[1]!.status).toBe("failed");
  });

  it("renvoie null si le rapport n'existe pas", async () => {
    const dir = await tmpDir("laneyard-rep-");
    expect(await readReport(join(dir, "report.xml"))).toBeNull();
  });

  it("renvoie null sur un rapport illisible plutôt que de lever", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), "<testsuites", "utf8");
    expect(await readReport(join(dir, "report.xml"))).toBeNull();
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/runner/`
Expected: échec — modules introuvables.

- [ ] **Step 3 : Implémenter les deux lecteurs**

`src/runner/live-steps.ts` :

```ts
/**
 * Repérage des séparateurs d'étape dans la sortie de fastlane, pendant le run.
 *
 * Fragile par nature : c'est du texte destiné aux humains. On n'en conserve donc
 * qu'une seule chose, le décalage en octets où chaque étape commence — la seule
 * information que report.xml ne contient pas. Les noms et durées qui font foi
 * viendront du rapport en fin de run.
 */
// Forme réelle observée, séquences ANSI comprises :
//   [13:14:00]: \x1b[32m--- Step: mkdir -p ../build && echo x > y.ipa ---\x1b[0m
// Le nom n'est pas un identifiant : pour une action `sh`, c'est la commande
// entière, espaces inclus. La capture est donc paresseuse jusqu'aux tirets
// de fermeture, et surtout pas `\S+`.
const SEPARATOR = /-{2,}\s+Step:\s*(.+?)\s+-{2,}/;

export interface LiveStep {
  name: string;
  logOffset: number;
}

export class LiveStepTracker {
  private pending = "";
  private pendingOffset = 0;
  private found: LiveStep[] = [];

  /** `offset` est la position du fragment dans le fichier de log. */
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

`src/runner/report.ts` :

```ts
import { readFile } from "node:fs/promises";

export interface ReportStep {
  idx: number;
  name: string;
  durationMs: number | null;
  status: "success" | "failed";
}

// La branche auto-fermante vient en premier : fastlane écrit les actions réussies
// sous la forme `<testcase … />` et seules les échouées ont un corps. Dans l'autre
// ordre, `[^>]*` avalerait le `/` final et le corps paresseux courrait jusqu'au
// `</testcase>` suivant, fusionnant deux actions et attribuant l'échec à la mauvaise.
const TESTCASE = /<testcase\b([^>]*?)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
// `\b` obligatoire : sans lui, chercher `name=` trouve d'abord la fin de
// `classname=`, que fastlane écrit systématiquement en premier attribut.
/**
 * Décode les entités XML d'une valeur d'attribut.
 *
 * Indispensable : un nom d'action `sh` contient la commande entière, donc
 * volontiers un `&&` ou une redirection, que le rapport écrit `&amp;&amp;`
 * et `&gt;`. Sans décodage, l'interface affiche l'échappement.
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
 * Lit le rapport JUnit que fastlane écrit à chaque exécution.
 * C'est la source qui fait autorité pour les noms, l'ordre, les durées et les échecs.
 *
 * Renvoie null si le rapport est absent ou illisible — cas normal pour un run annulé,
 * expiré, interrompu, ou qui a échoué avant même d'atteindre fastlane.
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

    // fastlane nomme ses cas « <index>: <action> ».
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

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/runner/`
Expected: 8 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/runner tests/runner
git commit -m "feat(runner): repérage des étapes en direct et lecture de report.xml"
```

---

### Task 10 : Collecte des artefacts

**Files:**
- Create: `src/runner/artifacts.ts`, `tests/runner/artifacts.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/runner/artifacts.test.ts` :

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
    await writeFile(join(dir, f), "contenu", "utf8");
  }
  return dir;
}

describe("guessKind", () => {
  it("reconnaît les types courants", () => {
    expect(guessKind("Popotes.ipa")).toBe("ipa");
    expect(guessKind("app-release.aab")).toBe("aab");
    expect(guessKind("app.apk")).toBe("apk");
    expect(guessKind("Popotes.app.dSYM.zip")).toBe("dsym");
    expect(guessKind("notes.txt")).toBe("other");
  });
});

describe("collectArtifacts", () => {
  it("déplace hors du workspace les fichiers correspondant aux motifs", async () => {
    const ws = await workspaceWith(["build/Popotes.ipa", "build/notes.txt"]);
    const dest = await tmpDir("laneyard-dest-");

    const found = await collectArtifacts(ws, ["build/**/*.ipa"], dest);

    expect(found).toHaveLength(1);
    expect(found[0]!.filename).toBe("Popotes.ipa");
    expect(found[0]!.kind).toBe("ipa");
    expect(found[0]!.size).toBeGreaterThan(0);
    expect(await readdir(dest)).toEqual(["Popotes.ipa"]);
  });

  it("ne renvoie rien quand aucun motif n'est configuré", async () => {
    const ws = await workspaceWith(["build/Popotes.ipa"]);
    expect(await collectArtifacts(ws, [], await tmpDir())).toEqual([]);
  });

  it("désambiguïse deux fichiers de même nom", async () => {
    const ws = await workspaceWith(["a/app.apk", "b/app.apk"]);
    const dest = await tmpDir("laneyard-dest-");

    const found = await collectArtifacts(ws, ["**/*.apk"], dest);

    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.filename)).size).toBe(2);
  });

  it("ignore un motif qui ne correspond à rien sans échouer", async () => {
    const ws = await workspaceWith(["build/Popotes.ipa"]);
    expect(await collectArtifacts(ws, ["nexiste/**/*.zip"], await tmpDir())).toEqual([]);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/runner/artifacts.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter la collecte**

`src/runner/artifacts.ts` :

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
 * Déplace hors du workspace tout fichier correspondant aux motifs configurés.
 *
 * Les motifs sont le seul contrat : Laneyard n'analyse pas la sortie du run pour
 * deviner des chemins. Le déplacement — et non la copie — évite de doubler
 * l'espace disque et garantit que le prochain build ne réutilisera pas un
 * artefact périmé par accident.
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
      // Deux chemins peuvent produire le même nom ; on préfixe plutôt que d'écraser.
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

> `rename` échoue entre deux systèmes de fichiers différents (`EXDEV`). Le workspace et le dossier
> d'artefacts vivent tous deux sous `~/.laneyard/`, donc le cas ne se présente pas ici. Si un jour
> ils divergent, remplacer par copie puis suppression.

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/runner/artifacts.test.ts`
Expected: 5 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/runner/artifacts.ts tests/runner/artifacts.test.ts
git commit -m "feat(runner): collecte des artefacts par motifs"
```

---

### Task 11 : Exécution dans un pseudo-terminal

**Files:**
- Create: `src/runner/pty.ts`, `tests/fixtures/fake-fastlane/*`, `tests/runner/pty.test.ts`

- [ ] **Step 1 : Créer le faux fastlane et écrire les tests qui échouent**

`tests/fixtures/fake-fastlane/fastlane` (rendre exécutable : `chmod +x`) :

```bash
#!/usr/bin/env bash
# Faux fastlane pour les tests : rejoue une sortie enregistrée sans rien construire.
#
#   FAKE_FASTLANE_SCENARIO=success|failure|slow
#   FAKE_FASTLANE_REPORT_DIR=<dossier où écrire report.xml, défaut $PWD/fastlane>
#
# Il imite le comportement réel : séparateurs d'étape, rapport JUnit écrit
# relativement au dossier courant, et production d'un artefact. Aucune dépendance
# à Xcode, la suite de tests est donc exécutable partout.
set -euo pipefail

scenario="${FAKE_FASTLANE_SCENARIO:-success}"
# Comme le vrai fastlane, le rapport est écrit dans le dossier fastlane du projet.
report_dir="${FAKE_FASTLANE_REPORT_DIR:-$PWD/fastlane}"

echo "[09:41:01]: Driving the lane '$*'"
echo "[09:41:02]: ------ Step: match ------"
echo "[09:41:03]: Installing certificates"
echo "[09:41:04]: ------ Step: build_app ------"
echo "[09:41:05]: Compiling sources"

if [ "$scenario" = "slow" ]; then
  sleep 30
fi

# Un build produit son artefact. Le dossier build/ est ignoré par git dans les
# fixtures, ce qui évite qu'un artefact déplacé salisse le workspace.
mkdir -p "$PWD/build"
echo "faux binaire" > "$PWD/build/Popotes.ipa"

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

`tests/runner/pty.test.ts` :

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInPty } from "../../src/runner/pty.js";
import { tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

describe("runInPty", () => {
  it("diffuse la sortie et rend un code de sortie nul en cas de succès", async () => {
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

  it("remonte le code de sortie d'un échec", async () => {
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "failure" },
      onData: () => {},
    });
    expect(res.exitCode).toBe(1);
  });

  it("tue le processus au-delà du délai imparti", async () => {
    const res = await runInPty({
      command: "fastlane",
      args: ["beta"],
      cwd: await tmpDir(),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "slow" },
      onData: () => {},
      timeoutMs: 1000,
    });
    expect(res.timedOut).toBe(true);
    // Tué par signal : le code doit refléter la mort violente, pas valoir 0.
    expect(res.exitCode).not.toBe(0);
    expect(res.signal).not.toBeNull();
  }, 20_000);

  it("échoue proprement si la commande n'existe pas", async () => {
    const res = await runInPty({
      command: "commande-inexistante-xyz",
      args: [],
      cwd: await tmpDir(),
      env: { PATH: "/nexistepas" },
      onData: () => {},
    });
    expect(res.exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `chmod +x tests/fixtures/fake-fastlane/fastlane && npm test -- tests/runner/pty.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter le lancement en PTY**

`src/runner/pty.ts` :

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
 * Lance une commande dans un pseudo-terminal.
 *
 * Le PTY sert deux buts : fastlane se croit dans un vrai terminal et garde son
 * affichage habituel, et une saisie reste possible si un jour un run en demande une.
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
    // Commande introuvable : selon la plateforme, node-pty lève ou rend 127.
    // On uniformise pour que l'appelant n'ait qu'un seul cas à traiter.
    opts.onData(`\nLancement impossible : ${(cause as Error).message}\n`);
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
        // SIGINT d'abord : fastlane fait son ménage. SIGKILL si l'obstination persiste.
        try {
          proc.kill("SIGINT");
        } catch {
          /* le processus a pu mourir entre-temps */
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* idem */
          }
        }, 5000);
      }, opts.timeoutMs);
    }

    proc.onExit(({ exitCode, signal }) => {
      if (timer) clearTimeout(timer);
      // `waitpid` ne renseigne un code de sortie que pour une fin normale : un
      // processus tué par signal laisse 0, ce qui ferait passer une annulation
      // pour une réussite. On applique la convention du shell, 128 + signal,
      // pour qu'un code de sortie reste toujours interprétable.
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
        /* déjà terminé */
      }
    },
  };

  return { handle, done };
}

/** Variante bloquante, pratique pour les tests et les commandes courtes. */
export async function runInPty(opts: PtyRunOptions): Promise<PtyRunResult> {
  return startPty(opts).done;
}
```

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/runner/pty.test.ts`
Expected: 4 tests passés. Sur un `PATH` sans la commande, `node-pty` remonte un code de sortie non
nul plutôt qu'une exception — c'est ce que vérifie le dernier test.

- [ ] **Step 5 : Réparer les droits du binaire de node-pty**

`node-pty` livre un exécutable auxiliaire, `spawn-helper`, que npm dépose parfois sans le bit
d'exécution. Tout `spawn` échoue alors avec un `posix_spawnp failed` incompréhensible, y compris
sur une commande aussi banale que `ls`. Le dépôt étant destiné à être public, mieux vaut réparer
que documenter.

`scripts/fix-node-pty-permissions.mjs` :

```js
#!/usr/bin/env node
// npm dépose parfois le spawn-helper de node-pty sans droit d'exécution, ce qui
// fait échouer tout lancement de processus avec un message opaque. On répare au
// lieu de laisser chacun le découvrir.
import { chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const root = "node_modules/node-pty/prebuilds";

try {
  for (const dir of await readdir(root)) {
    const helper = join(root, dir, "spawn-helper");
    try {
      const info = await stat(helper);
      // 0o111 : au moins un bit d'exécution.
      if ((info.mode & 0o111) === 0) {
        await chmod(helper, 0o755);
        console.log(`node-pty : droit d'exécution rendu à ${helper}`);
      }
    } catch {
      // Pas de helper dans ce dossier : rien à faire.
    }
  }
} catch {
  // node-pty absent ou sans prebuilds : l'installation n'a pas à échouer pour autant.
}
```

Ajouter à `package.json` :

```json
"postinstall": "node scripts/fix-node-pty-permissions.mjs"
```

Vérifier ensuite que les tests passent depuis une installation propre du binaire :

Run: `chmod -x node_modules/node-pty/prebuilds/*/spawn-helper && npm run postinstall && npm test -- tests/runner/pty.test.ts`
Expected: le script signale la réparation, puis 4 tests passés.

- [ ] **Step 6 : Commit**

```bash
git add src/runner/pty.ts tests/runner/pty.test.ts tests/fixtures/fake-fastlane scripts package.json
git commit -m "feat(runner): exécution dans un pseudo-terminal et faux fastlane de test"
```

---

### Task 12 : Orchestration d'un run

Le module qui enchaîne tout : préparer le workspace, lancer fastlane, écrire le log, réconcilier
les étapes, collecter les artefacts, poser le statut final.

**Files:**
- Create: `src/runner/orchestrate.ts`, `tests/runner/orchestrate.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/runner/orchestrate.test.ts` :

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
    // build/ est ignoré : l'artefact est produit par le faux fastlane pendant le
    // run, comme en vrai. Rien de suivi par git n'est déplacé, le workspace
    // reste donc propre pour le run suivant.
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
  it("mène un run au succès de bout en bout", async () => {
    const { runId, runs, logs } = await harness("success");
    const run = runs.get(runId)!;

    expect(run.status).toBe("success");
    expect(run.exitCode).toBe(0);
    expect(run.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(run.startedAt).not.toBeNull();
    expect(await logs.read(runId)).toContain("Step: build_app");
  }, 60_000);

  it("enregistre les étapes du rapport avec le décalage du repérage en direct", async () => {
    const { runId, runs } = await harness("success");
    const steps = runs.steps(runId);

    expect(steps.map((s) => s.name)).toEqual(["match", "build_app"]);
    expect(steps[0]!.source).toBe("report");
    expect(steps[0]!.durationMs).toBe(1500);
    expect(steps[1]!.logOffset).toBeGreaterThan(0);
  }, 60_000);

  it("collecte les artefacts correspondant aux motifs", async () => {
    const { runId, runs } = await harness("success");
    const arts = runs.artifacts(runId);

    expect(arts).toHaveLength(1);
    expect(arts[0]!.filename).toBe("Popotes.ipa");
    expect(arts[0]!.kind).toBe("ipa");
  }, 60_000);

  it("marque l'échec et retient un résumé d'erreur", async () => {
    const { runId, runs } = await harness("failure");
    const run = runs.get(runId)!;

    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(1);
    expect(runs.steps(runId).find((s) => s.name === "build_app")?.status).toBe("failed");
  }, 60_000);

  it("échoue proprement si la résolution des réglages lève", async () => {
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
      // Cas réel : le projet a disparu de config.yml pendant la préparation.
      resolveSettings: async () => {
        throw new Error("projet inconnu");
      },
      env: {},
      onChunk: () => {},
    });

    const run = runs.get(runId)!;
    expect(run.status).toBe("failed");
    expect(run.errorSummary).toMatch(/projet inconnu/);
  }, 60_000);

  it("échoue avant le lancement si le dépôt est inaccessible", async () => {
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
    expect(run.errorSummary).toMatch(/git|dépôt|clone/i);
    // Un run qui n'a jamais atteint fastlane n'a aucune étape.
    expect(runs.steps(runId)).toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/runner/orchestrate.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter l'orchestration**

`src/runner/orchestrate.ts` :

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
   * Résout les réglages effectifs. Appelée **après** la préparation du workspace,
   * parce que le laneyard.yml qu'elle lit vit dans le dépôt : au premier run,
   * il n'existe pas encore sur disque au moment où le run est créé.
   */
  resolveSettings: () => Promise<ProjectSettings>;
  env: NodeJS.ProcessEnv;
  /** Appelé pour chaque fragment de sortie, avec sa position dans le log. */
  onChunk: (chunk: string, offset: number) => void;
}

export interface ExecuteRunResult {
  status: "success" | "failed";
}


/**
 * Enchaîne un run complet et pose ses transitions d'état.
 *
 * Ne lève jamais : toute erreur est convertie en run `failed` documenté, parce
 * qu'un run qui disparaît sans laisser de trace est le pire des comportements
 * pour un serveur de build.
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

  // --- Préparation -------------------------------------------------------
  runs.setStatus(runId, "preparing");
  const workspace = new Workspace(opts.workspacePath, opts.gitUrl, opts.gitAuth);

  let commitSha: string;
  try {
    commitSha = await workspace.prepare(opts.branch, (line) => void emit(`${line}\n`));
  } catch (cause) {
    return fail(`Préparation du workspace impossible : ${(cause as Error).message}`);
  }

  runs.markRunning(runId, { branch: opts.branch, commitSha });

  // Le workspace existe enfin : c'est seulement maintenant que le laneyard.yml
  // du dépôt est lisible, donc seulement maintenant que les réglages sont connus.
  // La résolution est protégée : le projet peut avoir disparu de config.yml
  // pendant la préparation, et un run ne doit jamais s'évaporer sur une exception.
  let settings: ProjectSettings;
  try {
    settings = await opts.resolveSettings();
  } catch (cause) {
    return fail(`Réglages du projet illisibles : ${(cause as Error).message}`);
  }

  // --- Exécution ---------------------------------------------------------
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
      // Un run non interactif échoue vite au lieu de figer sur un prompt invisible.
      CI: "true",
      FASTLANE_SKIP_UPDATE_CHECK: "1",
      FORCE_COLOR: "1",
    },
    onData: (chunk) => void emit(chunk),
    timeoutMs: settings.timeout_minutes * 60_000,
  });

  const outcome = await done;
  await writer.close();

  // --- Chronologie -------------------------------------------------------
  const report = await readReport(reportPath);
  const live = tracker.steps();

  if (report) {
    // Le rapport fait autorité ; le repérage en direct n'apporte que les décalages.
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
    // Run annulé, expiré ou interrompu : on garde ce qui a été vu, en le signalant.
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

  // --- Artefacts et statut final ----------------------------------------
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
    ? `Run interrompu après ${settings.timeout_minutes} minutes`
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

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/runner/orchestrate.test.ts`
Expected: 5 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/runner/orchestrate.ts tests/runner/orchestrate.test.ts
git commit -m "feat(runner): orchestration complète d'un run"
```

---

### Task 13 : État vivant de la configuration

**Files:**
- Create: `src/config/store.ts`, `tests/config/store.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/config/store.test.ts` :

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
  it("charge la configuration au démarrage", async () => {
    const store = new ConfigStore(await configFile(CONFIG("popotes")));
    await store.load();
    expect(store.projects().map((p) => p.slug)).toEqual(["popotes"]);
  });

  it("retrouve un projet par son slug", async () => {
    const store = new ConfigStore(await configFile(CONFIG("popotes")));
    await store.load();
    expect(store.project("popotes")?.git_url).toBe("u");
    expect(store.project("inconnu")).toBeNull();
  });

  it("prend en compte une modification du fichier", async () => {
    const path = await configFile(CONFIG("un"));
    const store = new ConfigStore(path);
    await store.load();

    await writeFile(path, CONFIG("deux"), "utf8");
    await store.load();

    expect(store.projects().map((p) => p.slug)).toEqual(["deux"]);
  });

  it("conserve la dernière configuration valide si le fichier devient invalide", async () => {
    const path = await configFile(CONFIG("un"));
    const store = new ConfigStore(path);
    await store.load();

    await writeFile(path, "projects: [", "utf8");
    const res = await store.load();

    expect(res.ok).toBe(false);
    expect(store.projects().map((p) => p.slug)).toEqual(["un"]);
    expect(store.lastError()).not.toBeNull();
  });

  it("efface l'erreur quand le fichier redevient valide", async () => {
    const path = await configFile(CONFIG("un"));
    const store = new ConfigStore(path);
    await store.load();
    await writeFile(path, "projects: [", "utf8");
    await store.load();

    await writeFile(path, CONFIG("un"), "utf8");
    await store.load();

    expect(store.lastError()).toBeNull();
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/config/store.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter le magasin de configuration**

`src/config/store.ts` :

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
 * La configuration vivante du serveur.
 *
 * Règle de sûreté : une configuration invalide ne remplace jamais une configuration
 * valide. Le serveur continue de tourner avec ce qu'il avait, et l'erreur est
 * exposée à l'interface — jamais de démarrage à moitié configuré.
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

  /** Surveille le fichier et recharge, en absorbant les rafales d'événements. */
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
   * Résout les réglages effectifs d'un projet en lisant le laneyard.yml de son
   * workspace s'il existe. Le workspace peut ne pas encore être cloné : on
   * retombe alors sur le bloc du projet et les défauts.
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

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/config/store.test.ts`
Expected: 5 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/config/store.ts tests/config/store.test.ts
git commit -m "feat(config): état vivant, rechargement et résolution par projet"
```

---

### Task 14 : Serveur HTTP, authentification et API

**Files:**
- Create: `src/server/auth.ts`, `src/server/app.ts`, `src/server/routes/projects.ts`, `src/server/routes/runs.ts`, `tests/server/api.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/server/api.test.ts` :

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
  - slug: popotes
    name: Popotes
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
  it("refuse l'accès sans session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("refuse un mauvais mot de passe", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "faux" } });
    expect(res.statusCode).toBe(401);
  });

  it("liste les projets une fois connecté", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      cookies: { laneyard_session: session },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ slug: "popotes", name: "Popotes" }]);
  });

  it("renvoie les lanes d'un projet", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/popotes/lanes",
      cookies: { laneyard_session: session },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ name: "beta", platform: "ios" }]);
  });

  it("répond 404 pour un projet absent de la configuration", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/inconnu/lanes",
      cookies: { laneyard_session: session },
    });
    expect(res.statusCode).toBe(404);
  });

  it("crée un run en attente et le rend consultable", async () => {
    const { app } = await harness();
    const session = await login(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/popotes/runs",
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
    expect(fetched.json()).toMatchObject({ id, lane: "beta", projectSlug: "popotes" });
  });

  it("refuse de lancer une lane inconnue", async () => {
    const { app } = await harness();
    const session = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/popotes/runs",
      cookies: { laneyard_session: session },
      payload: { lane: "nexiste-pas", params: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/server/api.test.ts`
Expected: échec — modules introuvables.

- [ ] **Step 3 : Implémenter l'authentification et l'application**

`src/server/auth.ts` :

```ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * scrypt de la bibliothèque standard : aucune dépendance native supplémentaire,
 * et une résistance au calcul suffisante pour un mot de passe unique local.
 * Format : scrypt$<sel hex>$<clé hex>.
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

/** Sessions en mémoire : elles ne survivent pas à un redémarrage, et c'est très bien. */
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

`src/server/app.ts` :

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
  /** Racine de données : workspaces, logs, artefacts. */
  root: string;
  /** Injecté pour que les tests n'aient pas besoin de Ruby ni de fastlane. */
  lanes: (slug: string, workspacePath: string, fastlaneDir: string) => Promise<Lane[]>;
}

export interface AppContext extends AppDeps {
  runs: RunStore;
  logs: LogStore;
  sessions: SessionStore;
  sockets?: RunSockets;
  workspacePath: (slug: string) => string;
  artifactsDir: (runId: number) => string;
  /** Clone le dépôt s'il ne l'est pas encore. Lève si le clone échoue. */
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
      if (!entry) throw new Error(`Projet inconnu : ${slug}`);
      await new Workspace(workspacePath(slug), entry.git_url, entry.git_auth).ensureCloned();
    },
  };

  app.post("/api/login", async (req, reply) => {
    const { password } = req.body as { password?: string };
    const hash = deps.config.server()?.password_hash;

    if (!password || !hash || !verifyPassword(password, hash)) {
      return reply.code(401).send({ error: "Mot de passe incorrect" });
    }

    const token = ctx.sessions.issue();
    return reply
      .setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax" })
      .send({ ok: true });
  });

  // Tout /api sauf /api/login exige une session.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api") || req.url === "/api/login") return;
    if (!ctx.sessions.valid(req.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: "Session requise" });
    }
  });

  ctx.sockets = await registerWebSocket(app, ctx);

  await registerProjectRoutes(app, ctx);
  await registerRunRoutes(app, ctx);

  return app;
}
```

`src/server/routes/projects.ts` :

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
    if (!entry) return reply.code(404).send({ error: "Projet inconnu" });

    try {
      // Les lanes vivent dans le dépôt : sans clone, il n'y a rien à lire.
      // Un projet fraîchement déclaré doit être utilisable sans lancer un run à l'aveugle.
      await ctx.ensureWorkspace(slug);
      const resolved = await ctx.config.resolve(slug, ctx.workspacePath(slug));
      return await ctx.lanes(slug, ctx.workspacePath(slug), resolved!.settings.fastlane_dir);
    } catch (cause) {
      // Workspace pas encore cloné, Fastfile cassé, sidecar en échec : l'interface
      // doit pouvoir le dire à l'utilisateur plutôt qu'afficher une liste vide.
      return reply.code(503).send({ error: (cause as Error).message });
    }
  });

  app.get("/api/projects/:slug/runs", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Projet inconnu" });
    return ctx.runs.listByProject(slug);
  });
}
```

`src/server/routes/runs.ts` :

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
    if (!entry) return reply.code(404).send({ error: "Projet inconnu" });
    if (!body.lane) return reply.code(400).send({ error: "Lane manquante" });

    // On vérifie que la lane existe vraiment avant de créer un run voué à l'échec.
    try {
      await ctx.ensureWorkspace(slug);
      const resolved = await ctx.config.resolve(slug, ctx.workspacePath(slug));
      const lanes = await ctx.lanes(slug, ctx.workspacePath(slug), resolved!.settings.fastlane_dir);
      if (!lanes.some((l) => l.name === body.lane)) {
        return reply.code(400).send({ error: `Lane inconnue : ${body.lane}` });
      }
    } catch {
      // Lanes illisibles : on laisse passer, le run échouera avec un message clair.
    }

    const id = ctx.runs.create({
      projectSlug: slug,
      lane: body.lane,
      platform: body.platform ?? null,
      params: body.params ?? {},
    });

    // Lancé sans attendre : la réponse HTTP ne doit pas durer le temps d'un build.
    void executeRun({
      runId: id,
      runs: ctx.runs,
      logs: ctx.logs,
      workspacePath: ctx.workspacePath(slug),
      artifactsDir: ctx.artifactsDir(id),
      gitUrl: entry.git_url,
      gitAuth: entry.git_auth,
      branch: entry.default_branch,
      // Résolus après le clone, quand le laneyard.yml du dépôt est enfin lisible.
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
    if (!run) return reply.code(404).send({ error: "Run inconnu" });
    return { ...run, steps: ctx.runs.steps(id), artifacts: ctx.runs.artifacts(id) };
  });

  app.get("/api/runs/:id/log", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const from = Number((req.query as { from?: string }).from ?? 0);
    if (!ctx.runs.get(id)) return reply.code(404).send({ error: "Run inconnu" });
    return reply.type("text/plain; charset=utf-8").send(await ctx.logs.read(id, from));
  });

  app.get("/api/runs/:id/artifacts/:artifactId", async (req, reply) => {
    const { id, artifactId } = req.params as { id: string; artifactId: string };
    const artifact = ctx.runs.artifacts(Number(id)).find((a) => a.id === Number(artifactId));
    if (!artifact) return reply.code(404).send({ error: "Artefact inconnu" });

    return reply
      .header("Content-Disposition", `attachment; filename="${artifact.filename}"`)
      .type("application/octet-stream")
      .send(createReadStream(artifact.path));
  });
}
```

> `app.ts` importe `registerWebSocket` et le type `RunSockets` de la tâche 15. Pour que les tests
> de cette tâche-ci tournent avant, créer un `src/server/ws.ts` provisoire **fonctionnel** — un
> module vide ne suffit pas, l'import échouerait :
>
> ```ts
> import type { FastifyInstance } from "fastify";
>
> export class RunSockets {
>   broadcast(_runId: number, _chunk: string, _offset: number): void {}
>   finish(_runId: number, _status: string): void {}
> }
>
> // La signature accepte déjà les arguments du site d'appel dans `app.ts`,
> // sinon le typage échoue avant même que la tâche 15 existe.
> export async function registerWebSocket(
>   _app?: FastifyInstance,
>   _ctx?: unknown,
> ): Promise<RunSockets> {
>   return new RunSockets();
> }
> ```
>
> La tâche 15 le remplace par la vraie implémentation et ses tests.

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- tests/server/api.test.ts`
Expected: 7 tests passés.

- [ ] **Step 5 : Commit**

```bash
git add src/server tests/server
git commit -m "feat(server): authentification par session et API des projets et runs"
```

---

### Task 15 : Diffusion des logs par WebSocket

**Files:**
- Create: `src/server/ws.ts`, `tests/server/ws.test.ts`
- Modify: `src/server/app.ts` (enregistrer le module)

- [ ] **Step 1 : Écrire les tests qui échouent**

`tests/server/ws.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { RunSockets } from "../../src/server/ws.js";

interface FakeSocket {
  sent: string[];
  send(data: string): void;
}

const socket = (): FakeSocket => ({ sent: [], send(d) { this.sent.push(d); } });

describe("RunSockets", () => {
  it("diffuse un fragment aux abonnés du run", () => {
    const hub = new RunSockets();
    const a = socket();
    hub.subscribe(1, a);

    hub.broadcast(1, "sortie", 10);

    expect(JSON.parse(a.sent[0]!)).toEqual({ type: "chunk", offset: 10, data: "sortie" });
  });

  it("n'envoie rien aux abonnés d'un autre run", () => {
    const hub = new RunSockets();
    const autre = socket();
    hub.subscribe(2, autre);

    hub.broadcast(1, "sortie", 0);

    expect(autre.sent).toEqual([]);
  });

  it("cesse d'écrire à un abonné désinscrit", () => {
    const hub = new RunSockets();
    const s = socket();
    hub.subscribe(1, s);
    hub.unsubscribe(1, s);

    hub.broadcast(1, "sortie", 0);

    expect(s.sent).toEqual([]);
  });

  it("survit à un abonné dont l'envoi échoue", () => {
    const hub = new RunSockets();
    const cassé = { send() { throw new Error("socket fermée"); } };
    const sain = socket();
    hub.subscribe(1, cassé);
    hub.subscribe(1, sain);

    expect(() => hub.broadcast(1, "sortie", 0)).not.toThrow();
    expect(sain.sent).toHaveLength(1);
  });

  it("annonce la fin d'un run", () => {
    const hub = new RunSockets();
    const s = socket();
    hub.subscribe(1, s);

    hub.finish(1, "success");

    expect(JSON.parse(s.sent[0]!)).toEqual({ type: "finished", status: "success" });
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/server/ws.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter le concentrateur et le brancher**

`src/server/ws.ts` :

```ts
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { AppContext } from "./app.js";
import { SESSION_COOKIE } from "./auth.js";

/** Tout ce dont le concentrateur a besoin d'un client : pouvoir recevoir du texte. */
export interface Sink {
  send(data: string): void;
}

/**
 * Diffuse les fragments de sortie aux navigateurs qui regardent un run.
 *
 * Chaque message porte son décalage en octets : un client qui se reconnecte
 * demande le log depuis son dernier décalage connu et ne perd rien.
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
        // Un client mort ne doit jamais interrompre la diffusion aux autres.
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
    // Redondance assumée : le hook global d'`app.ts` refuse déjà tout `/api`
    // sans session, et le fait dès la poignée de main — un client non authentifié
    // reçoit un 401 HTTP et n'arrive jamais ici. Ce garde ne coûte rien et évite
    // qu'une exemption future de ce hook ouvre silencieusement le flux.
    if (!ctx.sessions.valid(req.cookies[SESSION_COOKIE])) {
      socket.close(4001, "Session requise");
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

`src/server/app.ts` appelle déjà `registerWebSocket` (tâche 14) : remplacer le module provisoire
par celui-ci suffit. Dans `routes/runs.ts`, notifier la fin du run :

```ts
void executeRun({ /* … */ }).then((r) => ctx.sockets?.finish(id, r.status));
```

- [ ] **Step 4 : Lancer toute la suite**

Run: `npm test`
Expected: tous les tests passent, y compris les 5 nouveaux.

- [ ] **Step 5 : Commit**

```bash
git add src/server tests/server/ws.test.ts
git commit -m "feat(server): diffusion des logs par WebSocket"
```

---

### Task 16 : Point d'entrée

**Files:**
- Create: `src/main.ts` (remplacer le contenu de la tâche 1), `tests/main.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/main.test.ts` :

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
  it("refuse de démarrer si la configuration est invalide", async () => {
    const root = await tmpDir("laneyard-main-");
    await writeFile(join(root, "config.yml"), "projects: [", "utf8");
    await expect(createServerFromConfig(root)).rejects.toThrow(/configuration/i);
  });

  it("marque interrompus les runs restés actifs au démarrage", async () => {
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

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `npm test -- tests/main.test.ts`
Expected: échec — `createServerFromConfig` n'existe pas.

- [ ] **Step 3 : Écrire le point d'entrée**

`src/main.ts` :

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

/** Assemble le serveur à partir d'un dossier de données. */
export async function createServerFromConfig(root: string): Promise<Started> {
  const config = new ConfigStore(join(root, "config.yml"));
  const loaded = await config.load();
  if (!loaded.ok) throw new Error(`Configuration illisible : ${loaded.error}`);

  const db = openDatabase(join(root, "laneyard.db"));

  // Aucun run ne peut survivre à l'arrêt du processus qui le portait.
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

/** Démarrage réel, hors tests. */
async function main(): Promise<void> {
  const root = process.env["LANEYARD_HOME"] ?? join(homedir(), ".laneyard");
  const { app, config } = await createServerFromConfig(root);

  config.watch((ok) => {
    if (!ok) console.error(`Configuration invalide, l'ancienne reste active : ${config.lastError()}`);
  });

  const server = config.server()!;
  await app.listen({ port: server.port, host: server.bind });
  console.log(`Laneyard écoute sur http://localhost:${server.port}`);
}

if (process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js")) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
```

Adapter `tests/smoke.test.ts` si nécessaire : `version` est toujours exporté.

- [ ] **Step 4 : Lancer toute la suite**

Run: `npm test && npm run typecheck`
Expected: tous les tests passent, aucune erreur de types.

- [ ] **Step 5 : Commit**

```bash
git add src/main.ts tests/main.test.ts
git commit -m "feat: point d'entrée et assemblage du serveur"
```

---

### Task 17 : Interface — squelette et thème

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/components/Login.tsx`, `web/src/theme.css`, `web/src/api.ts`
- Modify: `package.json` (dépendances et scripts du front)

- [ ] **Step 1 : Installer le front**

```bash
npm install --save-dev @vitejs/plugin-react vite
npm install react react-dom react-router-dom
npm install --save-dev @types/react @types/react-dom
```

Ajouter à `package.json` :

```json
"scripts": {
  "dev:web": "vite --config web/vite.config.ts",
  "build:web": "vite build --config web/vite.config.ts"
}
```

- [ ] **Step 2 : Écrire le thème**

`web/src/theme.css` — les jetons de la direction visuelle validée. Sombre par défaut, clair
disponible, zone terminal sombre dans les deux cas.

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

  /* La zone terminal ne suit pas le thème : les couleurs ANSI de fastlane
     sont pensées pour un fond noir, les retraduire trahirait la sortie. */
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
  /* Chasse fixe sur toute l'interface : c'est le choix le plus structurant
     de la direction visuelle, il ne souffre pas d'exception. */
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
}

/* Angles droits, filets d'un pixel, aucune ombre ni dégradé :
   les surfaces se distinguent par la valeur, pas par la profondeur. */
.panel { background: var(--bg-raised); border: 1px solid var(--border); }

.status-success { color: var(--ok); }
.status-running { color: var(--running); }
.status-failed,
.status-interrupted { color: var(--error); }
.status-queued,
.status-preparing { color: var(--text-dim); }
```

`web/src/api.ts` :

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

`web/index.html` :

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

`web/src/main.tsx` :

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

`web/src/App.tsx` — coquille de navigation. Les écrans arrivent aux tâches 18 et 19 ; à ce stade,
des composants vides suffisent à faire construire le projet.

```tsx
import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { Login } from "./components/Login";
import { api } from "./api";

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    // Un 401 sur le premier appel signifie qu'il faut se connecter.
    api
      .projects()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);

  if (authenticated === null) return <p className="dim">chargement…</p>;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  return (
    <div className="shell">
      <header>laneyard</header>
      <Routes>
        <Route path="/" element={<p className="dim">projets</p>} />
      </Routes>
    </div>
  );
}
```

`web/vite.config.ts` — la racine se résout depuis le dossier du fichier de configuration, il ne
faut donc surtout pas y remettre `"web"`.

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

`web/src/components/Login.tsx` doit exister avant que ce squelette construise : le prendre tel
quel dans la tâche 18, ou écrire une version minimale ici et la compléter ensuite.

- [ ] **Step 3 : Vérifier que le front se construit**

Run: `npm run build:web`
Expected: build réussi, fichiers émis dans `dist/web`.

- [ ] **Step 4 : Commit**

```bash
git add web package.json package-lock.json
git commit -m "feat(web): squelette Vite, thème et client d'API"
```

---

### Task 18 : Interface — liste des projets, lanes et déclenchement

**Files:**
- Create: `web/src/App.tsx`, `web/src/pages/Projects.tsx`, `web/src/pages/Project.tsx`, `web/src/components/Login.tsx`

- [ ] **Step 1 : Écrire les écrans**

`web/src/pages/Projects.tsx` :

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
        Aucun projet déclaré. Ajoutez un bloc dans <code>~/.laneyard/config.yml</code>.
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

`web/src/pages/Project.tsx` :

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
      {/* Une erreur de lecture des lanes est dite, jamais masquée par une liste vide. */}
      {lanesError && <p className="status-failed">Lanes illisibles — {lanesError}</p>}
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

`web/src/components/Login.tsx` :

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
        mot de passe{" "}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </label>
      <button type="submit">entrer</button>
      {failed && <p className="status-failed">Mot de passe incorrect</p>}
    </form>
  );
}
```

`web/src/App.tsx` et `web/src/main.tsx` : routage entre `/`, `/p/:slug` et `/r/:id`, avec la
barre latérale des projets et l'écran de connexion affiché tant qu'un appel renvoie 401.

- [ ] **Step 2 : Vérifier manuellement**

```bash
# Terminal 1
LANEYARD_HOME=/tmp/laneyard-demo npm run dev
# Terminal 2
npm run dev:web
```

Créer `/tmp/laneyard-demo/config.yml` avec un projet pointant vers un vrai dépôt, puis ouvrir
`http://localhost:5173`. Vérifier : connexion, liste des projets, liste des lanes, déclenchement.

- [ ] **Step 3 : Commit**

```bash
git add web/src
git commit -m "feat(web): liste des projets, lanes et déclenchement d'un run"
```

---

### Task 19 : Interface — écran de run et terminal en direct

**Files:**
- Create: `web/src/pages/Run.tsx`, `web/src/components/Terminal.tsx`, `web/src/useRunStream.ts`

- [ ] **Step 1 : Écrire le suivi de flux**

`web/src/useRunStream.ts` :

```ts
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * Suit la sortie d'un run.
 *
 * Le décalage en octets est la clé de la reprise : à la connexion comme après une
 * coupure, on redemande le log depuis le dernier décalage connu, puis on repart
 * du flux. Rien n'est perdu, rien n'est dupliqué.
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
          // Un fragment déjà couvert par le rattrapage est ignoré.
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

`web/src/components/Terminal.tsx` : `<pre>` sur fond `--term-bg`, défilement automatique tant que
l'utilisateur n'a pas remonté manuellement, et une ligne de saisie désactivée portant sa raison —
« mode interactif désactivé » — conformément à la spec.

`web/src/pages/Run.tsx` : en-tête (lane, branche, commit, statut, durée), chronologie des étapes à
gauche, terminal à droite, artefacts téléchargeables en bas. Les étapes ayant un `logOffset`
défilent le terminal jusqu'à la bonne position au clic.

- [ ] **Step 2 : Vérifier manuellement**

Lancer un run depuis l'interface et vérifier : la sortie arrive en direct, les étapes apparaissent
en fin de run, l'artefact se télécharge, et recharger la page en plein run ne perd aucune ligne.

- [ ] **Step 3 : Servir la SPA construite depuis le serveur**

Sans cela, l'application n'est accessible que derrière le serveur de développement Vite, et un
rechargement sur `/r/42` renvoie 404. Dans `src/server/app.ts`, après les routes :

```ts
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// …
// Résolu depuis l'emplacement du module, pas depuis le dossier de données :
// `deps.root` est ~/.laneyard, la SPA construite vit dans le dépôt.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "web");
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  // Le routage vit côté navigateur : toute URL inconnue rend l'application.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) return reply.code(404).send({ error: "Route inconnue" });
    return reply.sendFile("index.html");
  });
}
```

En développement, `dist/web` n'existe pas et le bloc est simplement ignoré : le proxy Vite prend
le relais.

- [ ] **Step 4 : Commit**

```bash
git add web/src src/server/app.ts
git commit -m "feat(web): écran de run, terminal en direct et artefacts"
```

---

### Task 20 : Vérification de bout en bout

**Files:**
- Create: `tests/e2e/full-thread.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/e2e/full-thread.test.ts` — le fil complet du jalon, sans navigateur : configuration sur
disque, dépôt git réel, faux fastlane, API HTTP.

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerFromConfig } from "../../src/main.js";
import { hashPassword } from "../../src/server/auth.js";
import { RunStore } from "../../src/db/runs.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

describe("fil complet", () => {
  it("déclare, clone, liste, lance, suit et récupère l'artefact", async () => {
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
  - slug: popotes
    name: Popotes
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
    expect(projects.json()).toMatchObject([{ slug: "popotes" }]);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/popotes/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: number };

    // Le run est asynchrone : on attend qu'il atteigne un état terminal.
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
    expect(body.artifacts[0]!.filename).toBe("Popotes.ipa");

    const log = await app.inject({ method: "GET", url: `/api/runs/${id}/log`, cookies });
    expect(log.body).toContain("Step: build_app");

    const download = await app.inject({
      method: "GET",
      url: `/api/runs/${id}/artifacts/${body.artifacts[0]!.id}`,
      cookies,
    });
    expect(download.statusCode).toBe(200);
    expect(download.body.trim()).toBe("faux binaire");

    await app.close();
  }, 120_000);
});
```

Ce test vérifie au passage deux choses non évidentes : que le `laneyard.yml` du dépôt est pris en
compte — sans lui, `runtime` vaudrait `bundle` et les motifs d'artefacts seraient vides — et qu'il
l'est **dès le premier run**, alors que le fichier n'existait pas sur disque au moment où le run a
été créé. C'est le scénario que la résolution tardive des réglages est là pour couvrir.

Il vérifie aussi que le workspace reste propre : l'artefact est produit par le run dans un dossier
ignoré par git, donc son déplacement ne laisse pas de modification non commitée qui ferait échouer
le run suivant.

- [ ] **Step 2 : Lancer le test**

Run: `npm test -- tests/e2e/full-thread.test.ts`
Expected: 1 test passé. En cas d'échec, lire le log du run — il est dans
`<root>/logs/<id>.log` et contient la sortie du faux fastlane.

- [ ] **Step 3 : Lancer toute la suite et le contrôle de types**

Run: `npm test && npm run typecheck`
Expected: tout passe.

- [ ] **Step 4 : Commit**

```bash
git add tests/e2e
git commit -m "test: vérification de bout en bout du fil complet"
```

---

### Task 21 : Commande `laneyard add` — adopter un projet fastlane existant

Le cas d'usage réel n'est pas de partir d'une page blanche mais d'un projet qui utilise déjà
fastlane. La commande s'exécute depuis le dossier du projet, détecte ce qu'elle peut et écrit le
bloc correspondant dans `config.yml` — sans jamais toucher au reste du fichier.

**Files:**
- Create: `src/cli/detect.ts`, `src/cli/add.ts`, `tests/cli/detect.test.ts`, `tests/cli/add.test.ts`
- Modify: `src/main.ts` (aiguillage de commande), `package.json` (champ `bin`)

- [ ] **Step 1 : Écrire les tests de détection**

`tests/cli/detect.test.ts` :

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
  it("trouve le dossier fastlane à la racine", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "lane :beta do\nend\n" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBe("fastlane");
  });

  it("trouve un dossier fastlane imbriqué dans un monorepo", async () => {
    const dir = await projectDir({ "apps/ios/fastlane/Fastfile": "lane :beta do\nend\n" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBe("apps/ios/fastlane");
  });

  it("signale l'absence de fastlane plutôt que de deviner", async () => {
    const dir = await projectDir({ "README.md": "rien" });
    const d = await detectProject(dir);
    expect(d.fastlaneDir).toBeNull();
  });

  it("choisit bundle quand un Gemfile est présent, system sinon", async () => {
    const avec = await projectDir({ "fastlane/Fastfile": "", Gemfile: 'gem "fastlane"' });
    expect((await detectProject(avec)).runtime).toBe("bundle");

    const sans = await projectDir({ "fastlane/Fastfile": "" });
    expect((await detectProject(sans)).runtime).toBe("system");
  });

  it("propose des motifs d'artefacts iOS sur un projet Xcode", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "", "Popotes.xcodeproj/project.pbxproj": "" });
    const d = await detectProject(dir);
    expect(d.artifactGlobs).toContain("**/*.ipa");
    expect(d.artifactGlobs.some((g) => g.includes("dSYM"))).toBe(true);
  });

  it("propose des motifs Android sur un projet Gradle", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "", "app/build.gradle": "" });
    const d = await detectProject(dir);
    expect(d.artifactGlobs).toContain("**/*.apk");
    expect(d.artifactGlobs).toContain("**/*.aab");
  });

  it("lit l'URL du distant et la branche courante", async () => {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "" });
    const clone = await tmpDir("laneyard-clone-");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["clone", origin, clone]);

    const d = await detectProject(clone);
    expect(d.gitUrl).toBe(origin);
    expect(d.defaultBranch).toBe("main");
  });

  it("déduit un slug du nom de dossier", async () => {
    const dir = await projectDir({ "fastlane/Fastfile": "" });
    const d = await detectProject(dir);
    expect(d.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/cli/detect.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 3 : Implémenter la détection**

`src/cli/detect.ts` :

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
  /** Chemin relatif du dossier contenant le Fastfile, ou null si introuvable. */
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

/** Un nom de dossier n'est pas un slug : on le normalise sans jamais échouer. */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "projet" : s;
}

/**
 * Inspecte un projet existant et propose une configuration.
 *
 * Ne décide rien d'irréversible : tout ce qu'elle renvoie est une proposition que
 * l'utilisateur voit et peut corriger avant écriture.
 */
export async function detectProject(dir: string): Promise<Detection> {
  // Le Fastfile peut être à la racine ou sous un sous-dossier, cas des monorepos.
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

- [ ] **Step 4 : Lancer les tests de détection**

Run: `npm test -- tests/cli/detect.test.ts`
Expected: 8 tests passés.

- [ ] **Step 5 : Écrire les tests d'écriture**

`tests/cli/add.test.ts` :

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addProjectToConfig } from "../../src/cli/add.js";
import { tmpDir } from "../fixtures/repos.js";

const EXISTING = `# Ma configuration Laneyard
server:
  port: 7890
  password_hash: "scrypt$a$b"   # mot de passe du serveur

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
  slug: "popotes-ios",
  name: "Popotes iOS",
  git_url: "git@example.com:popotes.git",
  default_branch: "main",
  fastlane_dir: "fastlane",
  runtime: "system" as const,
  artifact_globs: ["**/*.ipa"],
};

describe("addProjectToConfig", () => {
  it("ajoute le projet sans supprimer les projets existants", async () => {
    const path = await configAt(EXISTING);
    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as { projects: { slug: string }[] };
    expect(parsed.projects.map((p) => p.slug)).toEqual(["deja-la", "popotes-ios"]);
  });

  it("préserve les commentaires du fichier", async () => {
    const path = await configAt(EXISTING);
    await addProjectToConfig(path, entry);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("# Ma configuration Laneyard");
    expect(raw).toContain("# mot de passe du serveur");
  });

  it("refuse un slug déjà pris", async () => {
    const path = await configAt(EXISTING);
    await expect(addProjectToConfig(path, { ...entry, slug: "deja-la" })).rejects.toThrow(/deja-la/);
  });

  it("crée le fichier et la section serveur s'il n'existe pas", async () => {
    const dir = await tmpDir("laneyard-add-");
    const path = join(dir, "config.yml");

    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as {
      server: { password_hash: string };
      projects: unknown[];
    };
    expect(parsed.projects).toHaveLength(1);
    // Un mot de passe doit exister, sinon le serveur refuserait toute connexion.
    expect(parsed.server.password_hash).toMatch(/^scrypt\$/);
  });

  it("ajoute une section projects absente d'un fichier existant", async () => {
    const path = await configAt('server:\n  password_hash: "scrypt$a$b"\n');
    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as { projects: unknown[] };
    expect(parsed.projects).toHaveLength(1);
  });
});
```

- [ ] **Step 6 : Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test -- tests/cli/add.test.ts`
Expected: échec — module introuvable.

- [ ] **Step 7 : Implémenter l'écriture et la commande**

`src/cli/add.ts` :

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
 * Ajoute un bloc projet à config.yml en préservant le reste du fichier.
 *
 * L'édition passe par le document YAML plutôt que par un aller-retour
 * parse/serialize : les commentaires de l'utilisateur — et l'ordre de ses clés —
 * survivent. C'est la même exigence que pour le Fastfile : un fichier écrit à la
 * main ne doit jamais ressortir abîmé.
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
    // Un serveur sans mot de passe refuserait toute connexion : on en génère un
    // et on l'affiche une seule fois, à l'appelant de le noter.
    const generated = randomBytes(9).toString("base64url");
    doc.setIn(["server", "password_hash"], hashPassword(generated));
    process.stdout.write(`\nMot de passe généré : ${generated}\n  (notez-le, il ne sera plus affiché)\n`);
  }

  const projects = doc.getIn(["projects"]);
  const seq = projects instanceof YAMLSeq ? projects : new YAMLSeq();
  if (!(projects instanceof YAMLSeq)) doc.setIn(["projects"], seq);

  for (const item of seq.items) {
    const slug = (item as { get?: (k: string) => unknown }).get?.("slug");
    if (slug === entry.slug) {
      throw new Error(`Un projet porte déjà le slug « ${entry.slug} » dans ${path}`);
    }
  }

  seq.add(doc.createNode(entry));
  await writeFile(path, doc.toString(), "utf8");
}

/** Point d'entrée de `laneyard add`. */
export async function runAddCommand(cwd: string, configPath: string, slugOverride?: string): Promise<number> {
  const d = await detectProject(cwd);

  if (d.fastlaneDir === null) {
    process.stderr.write(
      "Aucun Fastfile trouvé ici. Laneyard pilote fastlane : lancez la commande depuis un projet " +
        "qui l'utilise déjà, ou exécutez d'abord `fastlane init`.\n",
    );
    return 1;
  }
  if (d.gitUrl === null) {
    process.stderr.write(
      "Aucun distant git nommé « origin ». Laneyard clone les projets depuis leur dépôt : " +
        "ajoutez un distant, ou renseignez git_url à la main dans config.yml.\n",
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
    `\nProjet « ${slug} » ajouté à ${configPath}\n` +
      `  dépôt        ${d.gitUrl} (${d.defaultBranch})\n` +
      `  fastlane     ${d.fastlaneDir}\n` +
      `  exécution    ${d.runtime}\n` +
      `  artefacts    ${d.artifactGlobs.join(", ") || "aucun motif détecté — à compléter"}\n` +
      `\nRelancez Laneyard ou attendez le rechargement automatique, le projet apparaîtra dans l'interface.\n`,
  );
  return 0;
}
```

Dans `src/main.ts`, aiguiller avant le démarrage du serveur :

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

Et dans `package.json` :

```json
"bin": { "laneyard": "dist/src/main.js" }
```

- [ ] **Step 8 : Lancer les tests**

Run: `npm test -- tests/cli/`
Expected: 13 tests passés.

- [ ] **Step 9 : Vérifier sur un vrai projet**

Depuis un projet mobile existant qui utilise fastlane :

```bash
LANEYARD_HOME=/tmp/laneyard-demo npx tsx /chemin/vers/laneyard/src/main.ts add
```

Vérifier que `/tmp/laneyard-demo/config.yml` contient un bloc cohérent, que le mot de passe généré
s'affiche une fois, et qu'une seconde exécution refuse le doublon de slug.

- [ ] **Step 10 : Commit**

```bash
git add src/cli tests/cli src/main.ts package.json
git commit -m "feat(cli): commande add pour adopter un projet fastlane existant"
```

---

## Ce que le jalon 1 laisse volontairement de côté

À traiter dans les plans suivants, dans cet ordre :

- **Jalon 2 — fiabilité** : caviardage des secrets avec tampon glissant, file d'attente et limite
  globale, annulation depuis l'interface, purge des runs orphelins au démarrage exposée dans l'UI.
- **Jalon 3 — secrets et Préparation CI** : coffre chiffré, injection dans l'environnement du run,
  module `src/heuristics/`, les cinq items de la check-list.
- **Jalon 4 — éditeur** : commandes `actions` et `parse` du sidecar, éditeur texte avec
  vérification, puis vue structurée et réécriture chirurgicale.
- **Jalon 5 — finitions et publication** : notifications, purge, thème clair, installation en
  service, README, CONTRIBUTING, licence.

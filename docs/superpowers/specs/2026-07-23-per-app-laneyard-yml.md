# Per-app `laneyard.yml`

Date: 2026-07-23
Status: approved, not implemented

## The problem

`laneyard.yml` is read from one place: the clone root
(`config/store.ts:89`, `join(workspacePath, "laneyard.yml")`). A repository gets
exactly one.

A monorepo holding two apps cannot have two. The author's own install already
has two Laneyard projects on one git remote; a single root file cannot describe
different build behaviour for each, and there is nowhere to put a second. The
file must be able to live in the app's own directory.

The author's decision, settled in conversation:

- `laneyard.yml` must be able to live **in the application directory**, so a
  monorepo of N apps carries N of them.
- Inside an app-level file, **paths are relative to the file's own directory** —
  `fastlane_dir: fastlane`, `artifact_globs: ['**/*.aab']`, not the repo-root
  prefix `app/`. A path belongs to the file that declares it, and an app moved
  or duplicated keeps its file unchanged.

## The one idea that keeps the blast radius small

Everything downstream already resolves paths as **repo-root-relative**:
`join(workspacePath, settings.fastlane_dir, …)` in artifacts, gradle-properties,
readiness, the sidecar, `required_secrets`. `settings.artifact_globs` are globbed
with `cwd: workspacePath` (`runner/artifacts.ts:43`).

So the app-relativity is resolved to nothing the moment the file is read.
An app-level `laneyard.yml` has its path fields **normalised back to
repo-root-relative by prefixing the app directory**, before
`resolveProjectSettings` ever sees them. Downstream code is untouched: it keeps
receiving `app/fastlane` and `app/**/*.aab`, exactly as it does today from a root
file or from `config.yml`.

Relativity becomes a property of *where the file was found*, collapsed once at
the boundary — not a new rule every path-handling site must learn.

## Design

### The anchor already exists

The server's `config.yml` block for a project carries `fastlane_dir`
(repo-root-relative, e.g. `app/fastlane`) — it is how the server locates the app
in the clone at all. `appRootOf(fastlane_dir)` (`heuristics/platforms.ts:55`)
already turns that into the app directory: `app`. That is the anchor, and it is
present for every monorepo project by necessity.

For a single-app repo where `fastlane_dir` is the default `fastlane`, the app
root is the repo root, and app-level and root-level coincide — nothing changes.

### Locating the file

`ConfigStore.resolve` (`config/store.ts`) looks in two places, in order:

1. `<workspace>/<appRoot>/laneyard.yml` — the app-level file, app-relative paths.
2. `<workspace>/laneyard.yml` — the repo-root file, repo-root-relative paths
   (back-compatible; existing installs keep working unchanged).

`appRoot` comes from the project's resolved `fastlane_dir` **as declared in
`config.yml`** — the server-side anchor, which is what points at the app before
any repo file is read. The chicken-and-egg is avoided: the location anchor is
always `config.yml`; the repo file only refines behaviour.

### Normalising an app-level file

Two settings are paths and are prefixed with `appRoot` when the file was found at
the app level:

- `fastlane_dir` — usually omitted (it defaults to `fastlane`, i.e. `<appRoot>/fastlane`).
  If present it is app-relative and normalised; it must resolve to the same
  directory the anchor pointed at. It does not need to be re-declared and normally
  is not.
- `artifact_globs` — each glob prefixed: `**/*.aab` → `app/**/*.aab`.

Everything else — `platforms`, `runtime`, `timeout_minutes`,
`interactive_default`, `required_secrets`, `retention` — is not a path and passes
through unchanged.

A root-level file is not normalised: its paths are already repo-root-relative.

Do the normalisation in one place, between reading the file and handing it to
`resolveProjectSettings`, so the merge and everything past it stay ignorant of
where the file lived.

### `laneyard setup`

Writes `laneyard.yml` into the **app directory** (`appRootOf` of the detected
`fastlane_dir`), with app-relative paths: `fastlane_dir` omitted when it is the
default, `artifact_globs` relative to the app. For a repo whose app root is the
repo root, this is the current behaviour.

The git-tracked warning added earlier still applies: the file, and the fastlane
dir beside it, must be committed and pushed to reach the clone.

### Precedence is unchanged

`config.yml` (server) → `laneyard.yml` (repo) → defaults, repo winning, exactly
as `resolveProjectSettings` already documents. The only change is *which*
`laneyard.yml` and *how its paths are read*.

## What does not change

- `resolveProjectSettings`, `runner/artifacts.ts`, `runner/gradle-properties.ts`,
  `heuristics/android-root.ts`, `heuristics/readiness.ts`, the sidecar, and
  `required-secrets.ts` all keep resolving repo-root-relative paths. None is
  touched.
- A repository with one app and a root `laneyard.yml` behaves exactly as before.

## Testing

- An `app/laneyard.yml` with `artifact_globs: ['**/*.aab']` resolves to
  `app/**/*.aab` and collects the same artifact a root file with `app/**/*.aab`
  would.
- Two projects on one remote, `app1/laneyard.yml` and `app2/laneyard.yml`, each
  resolve their own settings; neither sees the other's.
- A root `laneyard.yml` (no app-level file) still loads, paths unchanged.
- The app-level file wins over `config.yml` for a refined setting, and over the
  root file if somehow both exist (app-level is more specific).
- `setup` writes the file into the app dir with app-relative paths, and the
  git-tracked warning fires when that dir is untracked.

## Notes

Written against a working tree with the 0.2 back-compat removal in flight; line
references are to that tree. This feature touches `config/store.ts`,
`config/resolve.ts` (or a small normaliser beside it), `cli/setup.ts`, and the
README — and deliberately nothing in the path-resolving subsystems.

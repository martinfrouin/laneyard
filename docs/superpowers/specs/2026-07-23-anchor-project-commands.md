# Anchor project commands to their laneyard.yml

Date: 2026-07-23
Status: implemented

## The problem

`laneyard.yml` describes how one app builds and is committed at that app's root
(a monorepo carries one per app). But the commands that act on a project do not
use it as their anchor:

- `laneyard remove <slug>` runs against the data folder and takes the slug as an
  argument, from anywhere. It removes everything the machine holds for the
  project — but never the `laneyard.yml`, which is left in the repository with no
  project behind it.
- `laneyard setup` writes the file but does not record which project it belongs
  to inside it: the slug lives only in the machine's `config.yml`.

The result: nothing ties a checkout of the repository to the project it is, and
a removed project leaves its `laneyard.yml` orphaned.

## The model

A command that acts on **one** project runs only from the directory that holds
that project's `laneyard.yml`, and reads the project's identity from the file.
The file gains a `slug`. Commands that do not target a single project are
unaffected.

- **Runs anywhere** (unchanged): `setup` (it *creates* the file), the server
  (no argument), `reset`, `user`, `uninstall`, `--help`/`help`, `--version`.
- **Anchored to the app directory**: `remove`.
- **Removed entirely**: the `secret` CLI (`set`/`import`). Secrets are managed
  from the web; the vault and everything the server/web do with secrets are
  untouched.

## Changes

### `config/schema.ts` — the slug in the file

`projectSettingsSchema` gains `slug`, **optional**. Optional, not required, for
two reasons: the runtime reads this schema when the server builds, and an older
file without a slug must still parse; and `setup` writes it while `remove`
requires it, so the requirement belongs at the command, not the schema.

The slug is an identity, not a path — `normaliseAppConfig` prefixes only
`fastlane_dir` and `artifact_globs`, so it passes through untouched, and the run
ignores it (the server identifies the project through `config.yml`). It is
validated with the same slug regex used elsewhere.

### `cli/setup.ts` — write the slug

The `writeRepoConfigIfAbsent` call gains `slug` (already in scope). The slug is
written first, as the file's identity line. `setup` still runs from anywhere and
still never overwrites an existing `laneyard.yml`.

### `cli/remove.ts` — anchored, slug from the file

- Signature takes `cwd` (from `process.cwd()`); `main.ts` passes it.
- No slug argument. The slug is read from `./laneyard.yml` in `cwd`:
  - file absent → refuse: "run this from your app's directory, the one holding
    laneyard.yml".
  - file present but no slug → refuse: "this laneyard.yml has no slug — run
    laneyard setup again".
- The `laneyard.yml` path joins the inventory ("what will be removed") and shows
  in `--dry-run`.
- After the slug-typed-back confirmation, the file is deleted alongside the
  machine data. The closing message warns that the deletion must be committed —
  the file is committed, so it stays on the remote and in history otherwise, the
  same trap `runAdoption`'s report already names.
- A `laneyard.yml` whose slug names no project in `config.yml` still errors with
  the existing "unknown project" path — a natural guard against a stale file.

### `main.ts` — wiring

- `remove` is passed `process.cwd()` in addition to `homeDir()`.
- The `secret` command branch is removed; `laneyard secret …` becomes an
  unknown command.

### Delete the `secret` CLI

`cli/secret.ts`, `cli/secret-import.ts`, and their tests
(`tests/cli/secret.test.ts`, `tests/cli/secret-import.test.ts`) are removed. They
are imported only by `main.ts` and by each other. The vault and its tests
(`tests/secrets/`, `tests/db/secrets.test.ts`, `tests/server/*secret*`) stay —
those are the storage layer the web uses, not the removed command.

## Compatibility

Strict, and a clean break, taken because 0.6.0 is unreleased: a project set up
before this change has a `laneyard.yml` with no slug, and `remove` refuses it
until `setup` is run again (or the slug is added by hand). No slug-argument
fallback.

## Tests

- `schema`: a `laneyard.yml` with a slug parses and carries it; one without a
  slug still parses (runtime back-compat).
- `setup`: the written `laneyard.yml` contains the slug.
- `remove`: reads the slug from `./laneyard.yml`; refuses when the file is absent
  or slug-less; lists the file in the inventory and `--dry-run`; deletes the file
  on confirmation; errors on a slug naming no known project.
- `main`/CLI: `laneyard secret` is now unknown; removing the command breaks no
  other test.

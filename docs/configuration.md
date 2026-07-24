# Configuration

All configuration lives in files. The database holds execution state only, so backing up Laneyard
means copying one file, and restoring it means copying it back.

## `~/.laneyard/config.yml` — the server and its projects

```yaml
server:
  port: 7890
  bind: 0.0.0.0
  users:                         # written by `laneyard setup`, see Accounts
    - { name: martin, role: admin, password_hash: "scrypt$…" }
    - { name: lea, role: builder, password_hash: "scrypt$…", projects: [cartes-ios] }
  max_concurrent_runs: 1         # only 1 is accepted
  retention: { runs: 50, artifact_days: 30 }

projects:
  - slug: cartes-ios
    name: Cartes iOS
    git_url: git@github.com:you/cartes.git
    default_branch: main
    git_auth: { kind: ssh_key, ref: ~/.ssh/id_ed25519 }
```

`max_concurrent_runs` accepts `1` only: runs drain from a single queue, one at a time across every
project. A larger number is refused at load rather than ignored, so a server is never configured for
builds that never happen.

The `users` list is described in [Accounts](accounts.md).

## `laneyard.yml` — in your repository, and committed

Build behaviour belongs next to the code, versioned with it. `laneyard setup` writes this file;
commit it, and a colleague who clones the repository builds it the same way.

```yaml
slug: cartes-ios
fastlane_dir: fastlane
runtime: bundle                  # or `system`
timeout_minutes: 60
artifact_globs:
  - "build/**/*.ipa"
  - "build/**/*.app.dSYM.zip"
platforms: [ios]                 # or `[android]`, or both
env_file: .env                   # written for the run, see Credentials
```

`env_file` is where to write the file your build reads from disk — a gitignored `.env`, a
`config.json` for `--dart-define-from-file`. Leave it out and nothing is written; the Secrets tab
sets it for you, into `config.yml`. A path that climbs out of the app is refused.

`platforms` decides which half of the [readiness checklist](readiness.md) applies: an Android project
is never asked for an App Store Connect key. Left out, Laneyard looks **beside the Fastfile** — where
`ios/` and `fastlane/` are siblings — and reports what it found rather than assuming.

Field by field, the repository file wins over the server block, which wins over the defaults. Any
field may also go in the server block, so a repository you would rather not touch can be configured
entirely from `config.yml`.

**A monorepo carries one `laneyard.yml` per app**, beside that app's fastlane folder, and its paths
are relative to its own directory — so an app moved or duplicated keeps its file unchanged. A
root-level file still works, with repo-root-relative paths.

Both files are watched: edit them by hand and Laneyard picks the change up. An invalid file is
reported and the last valid configuration stays live — a typo never takes the server down.

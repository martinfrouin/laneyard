# Configuration


All configuration lives in files. The database holds execution state only, so backing up
Laneyard means copying one file, and restoring it means copying it back.

## `~/.laneyard/config.yml` — the server and its projects

```yaml
server:
  port: 7890
  bind: 0.0.0.0
  users:                         # written by `laneyard setup`, see Accounts
    - { name: martin, role: admin, password_hash: "scrypt$…" }
    - { name: lea, role: builder, password_hash: "scrypt$…", projects: [cartes-ios] }
  max_concurrent_runs: 1         # only 1 is accepted, see below
  retention: { runs: 50, artifact_days: 30 }

projects:
  - slug: cartes-ios
    name: Cartes iOS
    git_url: git@github.com:you/cartes.git
    default_branch: main
    git_auth: { kind: ssh_key, ref: ~/.ssh/id_ed25519 }
```

`max_concurrent_runs` accepts `1` only. Runs drain from a single queue, one at a time across every
project — parallel runs would need a working directory per run, which does not exist yet. A larger
number is refused at load, so a server is never configured for builds that never happen.

## Accounts

Everyone who signs in has a name, a password and one of two roles — two, because a third is easy to
add and impossible to remove.

| | **admin** | **builder** |
|---|---|---|
| start a build, watch it, cancel it | ✓ | ✓ |
| download artifacts, read logs and the Fastfile | ✓ | ✓ |
| see the readiness checklist | ✓ | ✓ |
| read and write secrets | ✓ | |
| save, commit and push the Fastfile | ✓ | |
| remove a project | ✓ | |
| manage accounts | ✓ | |

A builder is who you give someone who ships without being trusted with the signing chain: they press
the button and watch, and never see a credential.

The interface shows a builder only what a builder can use — no secrets, fastfile, settings or
accounts tabs. That is courtesy, not security: the server refuses those routes on its own, whatever
the browser was shown, and the test suite proves it for every verb and every spelling of the address.

### Which projects a builder reaches

An admin reaches every project. A builder reaches only the projects it is granted, from the accounts
screen. A project a builder cannot reach is **invisible**, not shown-and-locked — absent from its
lists and a 404 by URL, answered with the body a nonexistent project gives, so the two cannot be told
apart. Enforced by the server, in one place, not the browser.

The reach is a `projects` list on the account in `config.yml`, with three states:

- **absent** — every project. A config written before this feature grants everyone, so nobody loses
  access on an upgrade.
- **`[]`** — no project. What a new account starts with, so a new builder sees nothing until granted.
- **a list of slugs** — exactly those projects.

Removing a project strips its slug from every account, so a grant never points at a project that is
gone, and a re-created slug does not inherit an old grant.

Add and remove accounts from the accounts screen, or from the command line:

```bash
echo "$PASSWORD" | laneyard user add lea --role builder
```

The password is read from standard input, never an argument — an argument lands in your shell
history. Without `--role`, the account is a builder.

Two things are refused, in the API and CLI alike: removing or demoting the last admin. A server
nobody can administer cannot be repaired from the interface.

Anyone changes their own password and name from **your account** — a builder included. Either asks
for the current password even though you are signed in: a session is a cookie in a browser that may
have been left open on a desk. Doing it ends every other session that account has. That is how the
password `laneyard setup` printed once stops being a string on a sticky note.

Changing your name edits your `config.yml` entry in place, keeping your role and access, and refuses
a name another account already has. The next time you sign in, you type the new one — self-service,
whatever your role.

Removing an account ends its sessions immediately — "remove the account" and "revoke access" are the
same act. So does editing `config.yml` by hand: every request looks the account up again, so a change
takes effect at once rather than at the next restart.

## `laneyard.yml` — in your repository, and committed

Build behaviour belongs next to the code, so it can be versioned with it — `laneyard setup`
writes this file for you, and you should commit it. A colleague who clones the repository then
builds it the same way, without configuring anything.

```yaml
fastlane_dir: fastlane
runtime: bundle                  # or `system`
timeout_minutes: 60
artifact_globs:
  - "build/**/*.ipa"
  - "build/**/*.app.dSYM.zip"
platforms: [ios]                 # or `[android]`, or both
```

`platforms` decides which half of the readiness checklist applies: an Android project is never
asked for an App Store Connect key. Left out, Laneyard looks at the repository — an Xcode project
means iOS, a Gradle build means Android — and reports what it found rather than assuming.

It looks **beside the Fastfile**, not at the repository root, because that is where an app keeps its
platform folders: `ios/` and `fastlane/` are siblings and move together when the app is one directory
of a monorepo. When that guess is wrong, `platforms` settles it.

Field by field, the repository file wins over the server block, which wins over the defaults. Any
field may also go in the server block, so a repository you would rather not touch can be configured
entirely from `config.yml`.

**A monorepo carries one `laneyard.yml` per app**, in the app's own directory beside its fastlane
folder, so two apps on one remote each describe their own build. Inside an app-level file **paths are
relative to that file's directory** — `artifact_globs: ["**/*.aab"]`, a plain `fastlane_dir:
fastlane` usually left out — so an app moved or duplicated keeps its file unchanged. A `laneyard.yml`
at the repository root still works, with repo-root-relative paths.

Both files are watched: edit them by hand and Laneyard picks the change up. An invalid file is
reported and the last valid configuration stays live — a typo never takes the server down.


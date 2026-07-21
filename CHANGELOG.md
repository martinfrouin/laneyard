# Changelog

## 0.2.1 — unreleased

Everything below shipped in 0.2.0 except the three entries under *Changed*, which landed just
after it went out. If you installed 0.2.0, `laneyard add` still guesses silently and writes a
`fastlane_dir` measured from the wrong directory — upgrade.

## 0.2.0

### Secrets are encrypted, and kept out of the logs

Laneyard now stores credentials itself instead of inheriting whatever environment it was started
with.

- Secrets are encrypted with AES-256-GCM under a key in `~/.laneyard/key`, which never enters the
  database and which Laneyard refuses to use if anyone but its owner can read it.
- A masked secret is removed from a run's output **before** that output is written to disk or sent
  to a browser — not when it is displayed. The redactor holds back the few characters that could
  still turn into a secret, so a value split across two chunks of terminal output cannot slip
  through in pieces.
- Manage them from the Secrets tab, or from `laneyard secret set NAME`, which reads the value from
  standard input so it never lands in your shell history.
- A value shorter than four characters is refused rather than accepted and quietly not protected.

### A readiness checklist per project

A new tab tells you what stands between a project and a build that runs while nobody watches,
instead of leaving you to find out at 2am.

- Five checks: the repository answers without asking for credentials, the dependencies are
  installable, App Store Connect has an API key rather than a session that expires, `match` has
  its passphrase and is called `readonly`, and no lane calls an action known to stop and ask.
- Every check explains what to do. Nothing is fixed automatically — Laneyard does not edit a
  Fastfile to make its own checklist go green — and no check ever blocks a run.
- Arguments are read as literals, so `match(readonly: ENV["RO"])` is reported as undetermined
  rather than guessed. A checklist that guesses gets believed.
- The checks run when you open the tab or press refresh, never on their own, and the tab shows
  when they last ran.

### Edit the Fastfile from the browser

A new tab per project, and it is a text editor: your file, in a box, with Ruby syntax
highlighting. The structured view described in the design document is still to come — this is the
half that is useful on its own, because fixing a lane at 2am should not require an SSH session.

- **Every write is verified.** The file is written byte-for-byte, then fastlane is asked to parse
  it and list its lanes. If that fails, the previous content is back on disk before the request
  answers, and fastlane's own reason appears above the editor with your work still in the box.
- Saving is explicit — verification is a Ruby subprocess, not a regular expression. `⌘S` is
  another way to ask, not an autosave.
- Writing is refused outright while a run of that project is in flight: that run is reading the
  file the write would replace.
- Below the editor: the diff, a message field, `commit` and `push`. A commit stages exactly the
  files that changed and never `git add -A` — a build leaves artifacts and reports scattered
  around, and none of them belong in your history.
- CodeMirror is bundled, never fetched from a CDN, and loaded only by this tab: a build machine
  with no route to the internet opens this screen like any other, and the other three tabs weigh
  what they did before.

### Builds queue instead of being refused

- Triggering a run while another is in flight no longer returns an error. Runs queue and execute
  one at a time, across all projects, and the interface shows each one's place in line.
- Any run can be cancelled, whether it has started or not. A cancelled run keeps its log — what it
  managed to do before being stopped is often the reason it was stopped.
- Runs left queued when the server stops are still there when it starts again. Only runs that had
  actually begun are marked interrupted; a queued run never began.

### Refusals instead of settings that do nothing

Two pieces of configuration were accepted and then ignored. Both are now rejected when the file is
loaded, with an explanation:

- `git_auth: { kind: token }` — only SSH keys are implemented.
- `max_concurrent_runs` above 1 — the queue is serial; parallel builds need a working directory
  per run, which does not exist yet.

### Added in 0.2.1

- **Named accounts, and a role that only builds.** `config.yml` now holds a list of accounts
  under `server.users` — a name, a password hash and one of two roles each. An **admin** does
  everything. A **builder** starts a build, watches it, cancels it and downloads what it
  produced, and never sees a secret, cannot save a Fastfile, cannot remove a project and cannot
  manage accounts. It is what you give someone who ships without being trusted with the signing
  chain, which until now meant handing over the one password and everything behind it.
  - The login form takes a name and a password, and the status bar says who is signed in, with
    `sign out` beside it.
  - Accounts are managed from a new accounts screen, or with
    `echo "$PASSWORD" | laneyard user add lea --role builder` — the password is read from
    standard input, never taken as an argument, exactly as `laneyard secret set` already did.
  - A builder is not shown the secrets, fastfile or settings tabs, nor the accounts screen. That
    is courtesy: one table names the routes that require an admin, one hook enforces it, and the
    suite proves a builder is refused by every verb and every spelling of the address.
  - Removing an account ends its sessions at once — "remove the account" and "revoke access" are
    the same act. Editing `config.yml` by hand has the same effect: the account is looked up
    again on every request, so a demotion takes effect immediately rather than at the next
    restart.
  - The last admin can be neither removed nor demoted, from the interface or from the command
    line. A server nobody can administer cannot be repaired from the interface.
  - **Upgrading:** an existing `server.password_hash` keeps working unedited, read as a single
    admin called `admin`. Sign in with that name and your existing password. Adding a second
    account rewrites the file into the `users` form, comments and all. A file holding both forms
    is refused at load — there is no obvious winner.
- **`platforms` is configuration, not a guess.** `laneyard.yml` takes `platforms: [ios]`,
  `[android]` or both, and `laneyard setup` writes what it detected so the value can be corrected
  by editing one line. Left out, Laneyard still looks at the repository and reports what it found
  rather than assuming.
- **The readiness checklist knows what it is looking at.** It is now a shared section plus one per
  platform, and a project is only shown the sections that apply to it. An Android project is no
  longer told off for having no App Store Connect key — one irrelevant warning teaches you to
  ignore the whole screen.
- **A credential can be a file.** An App Store Connect key arrives as a `.p8` and a Play Store
  service account as JSON; pasting either into a text field is the moment you are most likely to
  paste it somewhere else by accident. The Secrets tab takes the file directly, under the names
  the checklist looks for — `APP_STORE_CONNECT_API_KEY_P8` and `SUPPLY_JSON_KEY_DATA`. Your
  browser reads it and sends its text to the route a typed value already used: nothing is
  uploaded, nothing is written to disk on the way, and the page only ever shows the file's name.
- **A project can be removed from the interface**, from a new Settings tab, instead of editing
  `config.yml` by hand. It is the one destructive action in Laneyard, so it is confirmed by typing
  the project's name rather than by a dialogue you can click through, and most of the screen is
  what it does *not* do: the runs stay, each still at its own address with its log and artifacts;
  the clone and the artifacts stay on disk, with their paths printed so you can remove them
  yourself; the secrets stay in the vault and come back if you add the project again. It is
  refused while a run of that project is in flight, since that run holds the workspace.

### Fixed in 0.2.1

- **Editing `config.yml` no longer rewraps lines nobody touched.** Adding or removing a project
  serialized the document at YAML's default width, folding the password hash across two lines. The
  file still parsed, which is exactly why it went unnoticed until someone opened it.
- **Listing lanes never worked from an installed copy.** The sidecar script was located two levels
  above its module, which is right when running from the sources and wrong once built — an
  installed Laneyard looked for it in `dist/ruby/` and reported "No such file or directory". Both
  0.1.0 and 0.2.0 are affected: the feature the whole tool is built on was broken for everyone who
  installed it, and worked perfectly for the one person running it from a checkout.

### Changed in 0.2.1

- **`laneyard setup` writes two files, and says which is which.** Build behaviour — the fastlane
  directory, whether to use bundler, what to keep — now goes into `laneyard.yml` in the
  repository, where it can be committed and where a colleague cloning the project inherits it. The
  machine's `config.yml` keeps only what is about this machine: where to clone from, and who may
  sign in. Setup used to put everything in the machine's file, so nothing was ever versioned.
- **`laneyard setup` creates the first admin** on a machine that has none, asking what to call it
  and printing its generated password once. It writes the `users` form and never a bare
  `password_hash`.
- It warns when the project is already registered, or when the repository already has a
  `laneyard.yml` — which it never overwrites.
- Setup and startup say more, and in colour. Starting with no project configured now says how to
  add one instead of looking successful and doing nothing.

### Changed

- **`laneyard add` is now `laneyard setup`, and it asks.** It used to detect everything silently
  and write the result. When a guess was wrong the configuration looked plausible and pointed
  nowhere, and the failure surfaced later as an unreadable lane list, far from its cause. It now
  shows each value and lets you correct it; `--yes` keeps the old behaviour for scripts.
- **Paths are measured from the repository root, not the current directory.** Running setup inside
  `app/` of a monorepo wrote `fastlane_dir: fastlane` while the clone holds it at `app/fastlane`,
  so the lane list failed with ENOENT. Artifact patterns are anchored to the sub-project too — an
  unanchored `**/*.ipa` would collect a sibling app's build as if it were this one's.
- **A project is named after its repository**, plus the sub-directory when there is one:
  `popotheque-app` rather than `app`. The folder something was cloned into is an accident.

### Fixed
- A Fastfile whose top level called an action — `default_platform(:ios)`, the first line of most
  real ones — could not be read at all: the lane list came back as an error about an unknown
  action. Loading a Fastfile runs it, so fastlane's action catalogue now goes in first.
- Installing the package no longer downloads React and CodeMirror. They build the interface, which
  ships already built; nine runtime dependencies remain.

- A run could take the whole server down with it: `executeRun` could throw on three paths after
  the build finished, and its only caller had no rejection handler. An unhandled rejection ends
  the Node process, and every other run with it.
- Logging in blocked the event loop for about 30 ms per attempt with no rate limit — enough for
  anyone on the network to freeze live log streaming, and to brute-force at speed. Password
  verification is now asynchronous and repeated failures are throttled.
- The repository URL, which may carry a token, was copied verbatim into stored error messages.
- `report.xml` indexes come from action names rather than positions and could repeat, which
  violated a primary key and aborted the timeline.
- Two concurrent runs of the same project could silently corrupt each other's results. They now
  queue.

## 0.1.0 — 2026-07-21

First release. Declare a project, clone it, list its lanes, run one, watch it stream, download the
artifact. Configuration entirely in files. `laneyard setup` adopts a project that already uses
fastlane.

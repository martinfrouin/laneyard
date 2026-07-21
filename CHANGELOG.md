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

### Fixed in 0.2.1

- **Listing lanes never worked from an installed copy.** The sidecar script was located two levels
  above its module, which is right when running from the sources and wrong once built — an
  installed Laneyard looked for it in `dist/ruby/` and reported "No such file or directory". Both
  0.1.0 and 0.2.0 are affected: the feature the whole tool is built on was broken for everyone who
  installed it, and worked perfectly for the one person running it from a checkout.

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

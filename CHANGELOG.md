# Changelog

## 0.2.0 — unreleased

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

### Fixed

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
artifact. Configuration entirely in files. `laneyard add` adopts a project that already uses
fastlane.

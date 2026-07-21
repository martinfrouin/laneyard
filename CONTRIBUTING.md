# Contributing to Laneyard

## Getting the tests running

```bash
npm install
npm test        # the whole suite, a few seconds
npm run typecheck
```

**No Xcode, no signing certificates, no network.** `tests/fixtures/fake-fastlane/fastlane` is a
bash script that impersonates fastlane: it prints the same step separators, writes a real JUnit
`report.xml` where fastlane writes it, and produces a build artifact. That is what lets the whole
runner — pseudo-terminal, log offsets, step reconciliation, artifact collection — be exercised end
to end on any machine.

Two suites do use real things on purpose: `tests/git/` runs actual git commands against
throwaway repositories, and `tests/ruby/` runs the real sidecar against the fastlane you have
installed. Both are slower. Both have earned their place by catching bugs a mock would have
agreed with.

## The one rule that matters

**Laneyard hard-codes no knowledge of fastlane.** Not action names, not their parameters, not
lane lists. All of it is asked, at runtime, of the fastlane installed in the user's own project,
through `ruby/introspect.rb`. That is what makes the tool survive fastlane upgrades and support
third-party plugins without any work here.

There is exactly one exception, and it is fenced off in `src/heuristics/`. See below.

## Architecture in one page

```
config/     Reads config.yml and each project's laneyard.yml, merges them field by
            field, and keeps the last valid configuration alive when a file breaks.
db/         SQLite. Execution state only — runs, steps, artifacts, caches.
            There is deliberately no `project` table: configuration lives in files.
git/        The clone Laneyard keeps per project, and the rules about when it may
            be moved (never over uncommitted changes to tracked files).
sidecar/    Invoking ruby/introspect.rb and caching what it says. `ruby-env.ts`
            exists because plain `ruby` cannot always load fastlane — Homebrew puts
            it in a private GEM_HOME behind a launcher script.
logs/       Append-only writing and reading from a byte offset. Offsets are bytes,
            never characters; the browser's reconnect-and-resume depends on it.
runner/     Running fastlane in a pseudo-terminal, spotting step separators live,
            reading report.xml afterwards, collecting artifacts, and orchestrating
            all of it into a run that never vanishes without a recorded reason.
heuristics/ Named knowledge of fastlane. Fenced off. See below.
server/     Fastify: session auth, REST, and the WebSocket that streams a run.
cli/        `laneyard add` — inspecting an existing project and writing its block.
web/        The React interface.
```

## Two recipes

### Adding a rule to the heuristics module

`src/heuristics/` is the only place allowed to know fastlane by name — that a failure line starts
with `[!]`, that `match` needs `MATCH_PASSWORD`. Three conditions apply, and a change that breaks
one of them will be sent back:

1. It lives in `src/heuristics/`, never scattered into the runner, the sidecar or the editor.
2. **It never blocks and never modifies.** It does not refuse a run, hide a lane or touch a
   Fastfile. It produces information: a warning, a summary shown next to the log — and the full
   log always remains the reference.
3. It reads as a table of rules, not as scattered imperative code, so it stays legible as fastlane
   changes.

Start from `src/heuristics/error-summary.ts` and its tests.

### Changing what a run does

`src/runner/orchestrate.ts` is the spine: prepare the workspace, resolve settings, run fastlane,
reconcile the timeline, collect artifacts, record the verdict. Two invariants:

- **It never throws.** Every failure becomes a `failed` run with a recorded reason. A run that
  disappears without a trace is the worst thing a build server can do.
- **Settings are resolved after the clone**, never before — a project's `laneyard.yml` lives
  inside its repository and does not exist on disk when the run is created.

`tests/runner/orchestrate.test.ts` runs the whole chain against the fake fastlane; add your case
there.

## Style

- Comments explain **why**, not what. The interesting ones record a decision or a trap: why a
  regular expression is shaped the way it is, why a guard exists. Those are what a future reader
  needs; the code already says what it does.
- Interface labels are lowercase. That is deliberate, not an accident.
- Colour is semantic only: green success, amber running, red failure, blue landmark.

## Before opening a pull request

`npm test` and `npm run typecheck` pass. If you touched the interface, `npm run build:web` too,
and say what you saw when you ran it — a screenshot is worth a paragraph.

If a test fails, do not adjust its expectation to match your output. Work out which side is
wrong; several real bugs in this codebase were caught exactly there.

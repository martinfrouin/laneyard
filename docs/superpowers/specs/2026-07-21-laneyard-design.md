# Laneyard — design

**Date**: 2026-07-21
**Status**: validated, ready for implementation planning

## The problem

Triggering, following, and editing mobile builds today means going through either a terminal
on the dev machine, or a hosted service like Bitrise — billed, opaque, and the owner of the
signing chain.

Laneyard is a self-hosted build server built on fastlane. It runs on a machine you own,
exposes a web interface on your local network, and lets you trigger lanes, follow their
execution live, and edit the Fastfile without opening an editor.

## Scope

**In v1**

- Several registered projects, each cloned from its git repository.
- Manual triggering of a lane from the interface, with its parameters.
- Live follow-up: streamed logs, action timeline, status, duration.
- Run history with downloadable artifacts.
- Fastfile editing: structured view by actions and a text editor, then commit and push.
- Configuration entirely file-driven, secrets excluded — backupable and
  versionable, with the interface being nothing more than an editor for these files.
- `laneyard add`: adopting an existing fastlane project by detection, from its folder.
- Vault of secrets injected as environment variables.
- End-of-run notifications: browser notification, plus an optional webhook per project.
- "CI Readiness" screen: per-project autonomy checklist.
- Public documentation: README, CONTRIBUTING, MIT license — the repository is public from the start.

**Out of v1, but the design must not make them impossible**

- Git triggers (branch polling, webhooks) — the `trigger` column already exists.
- Scheduled runs.
- Multiple execution machines.

**Explicitly out of scope**

- Multi-user, roles, permissions. A personal tool, one password.
- Cloud hosting, exposure on the Internet.
- Support for tools other than fastlane.

## Constraints

- Runs on macOS **and** Linux — an Android project has no reason to require a Mac.
- Target: a dedicated machine that stays on, driven from a browser on the local network.
- No fastlane knowledge hardcoded **in the sidecar and in the editor**: no action
  names, no parameters, no lanes. See "Heuristics boundary" for the two places where
  known names are allowed.
- A secret must never end up in a log file.
- The user's Fastfile must never come out of an edit damaged.

### Heuristics boundary

Two features need to know fastlane by name: the CI Readiness checklist
(which talks about `match`, `MATCH_PASSWORD`, App Store Connect) and the error-summary
extraction. This knowledge is allowed, under three strict conditions:

1. It lives in a single, isolated module, `src/heuristics/`, never scattered across the runner,
   the sidecar, or the editor.
2. It **never blocks and never modifies**. A heuristic does not refuse a run, does not hide
   a lane, does not touch a Fastfile. It produces information: a warning
   in the checklist, an error summary next to the full log, which always remains authoritative.
3. It is described as a table of declarative rules, not as scattered imperative code,
   so it stays readable as fastlane evolves.

The sidecar and the editor, meanwhile, stay at zero hardcoded knowledge. This is an absolute rule:
an unknown fastlane plugin must be treated just as well as an official action.

## Architecture

```
Browser (workstation)
        │  HTTP + WebSocket over the LAN, session cookie
        ▼
┌─────────────────────────────────────────────────────┐
│ Host machine — launchd (macOS) or systemd (Linux)   │
│                                                      │
│  Fastify + WebSocket server                         │
│      │                    │                          │
│      ▼                    ▼                          │
│  Runner              Ruby sidecar                    │
│  (node-pty,          (bundle exec ruby               │
│   queue)              introspect.rb)                 │
│      │                    ┆                          │
│      ▼                    ┆                          │
│  SQLite · git workspaces · logs · artifacts          │
└──────┼────────────────────┼──────────────────────────┘
       ▼ PTY                ┆ Ruby API
    fastlane — the project's own, from its Gemfile
```

### Choice: Node/TypeScript with a Ruby sidecar

The backend is in TypeScript (Fastify). All fastlane knowledge comes from a Ruby script
launched **inside the bundle of the project concerned**.

Two alternatives were ruled out:

- **All-Ruby backend** — native access to the fastlane API, but Laneyard would become a prisoner
  of a specific Ruby environment, would coexist poorly with projects' Gemfiles, and the
  real-time ecosystem is less practical there.
- **Go/Rust binary parsing text output** — ideal deployment, but without the Ruby API the
  action metadata is lost and the structured editor would fall back to a hardcoded
  list that goes stale with every fastlane version. A dealbreaker.

The sidecar entirely isolates Laneyard from each project's Ruby while giving it access to the
real version of fastlane and the installed plugins.

### Components

#### Server (`src/server`)

Single entry point. REST for actions, WebSocket for streaming logs and forwarding
keyboard input to the PTY. A hashed password in configuration, a cookie-based session.
Listens on `0.0.0.0` by default.

#### Runner (`src/runner`)

Runs the jobs. Queue with **one run at a time per project** — two builds can't
share a git workspace — and a configurable global limit, 1 by default, because an Xcode
build hogs the machine.

#### Ruby sidecar (`ruby/introspect.rb`)

The only component that knows fastlane. Three commands, JSON output, never modifies anything:

| Command   | Output |
|-----------|--------|
| `lanes`   | The project's lanes: name, platform, description, expected parameters |
| `actions` | All available actions with their typed options (key, type, description, default, environment variable), project plugins included |
| `parse`   | Fastfile syntax tree with the byte positions of each statement |

The underlying API is verified:

```ruby
require "fastlane"
Fastlane.load_actions
klass = Fastlane::Actions.action_class_ref("build_app")
klass.available_options.map { |o| { key: o.key, desc: o.description,
                                    type: o.data_type.to_s, optional: o.optional,
                                    env: o.env_name } }
```

The syntax analysis uses Prism, Ruby's official parser, to get the exact
positions in the file.

#### Frontend (`src/web`)

React SPA. Three levels of navigation: projects → project → run.

### Storage

SQLite for execution state. Files on disk for configuration, logs, and
artifacts: a build log weighs several megabytes and has no business being in the database.

```
~/.laneyard/
  config.yml             # server and project configuration — versionable
  laneyard.db            # runs, steps, artifacts, encrypted secrets, cache
  key                    # secret encryption key, 0600
  workspaces/<slug>/     # git clones, kept between runs
  logs/<run>.log
  artifacts/<run>/
```

## File-based configuration

**All configuration, secrets excluded, lives in text files.** The interface is an
editor for these files, never a parallel source of truth. Backing up a Laneyard server
means copying a single file, `config.yml`; restoring it elsewhere means copying it back and
re-entering the secrets. The rest of the configuration already travels with the code, in the
repositories.

### `~/.laneyard/config.yml` — the server and its projects

What Laneyard needs to know before it has even cloned anything.

```yaml
server:
  port: 7890
  bind: 0.0.0.0
  password_hash: "$argon2id$..."
  max_concurrent_runs: 1
  retention: { runs: 50, artifact_days: 30 }

projects:
  - slug: sample-ios
    name: Sample iOS
    git_url: git@github.com:martin/sample.git
    default_branch: main
    git_auth: { kind: ssh_key, ref: ~/.ssh/id_ed25519 }
    color: green
    notify_browser: true
    webhook_url: $SLACK_WEBHOOK      # secret reference, never the value
    # any field from laneyard.yml can also appear here
    artifact_globs: ["build/**/*.ipa"]
```

`git_auth.ref` is read according to `kind`: a file path for `ssh_key`, a secret name for
`token`. The `slug` is the identity key for all of the history: renaming it in the file
would detach runs and secrets, so it's treated as immutable. Renaming a project goes through an
explicit operation in the interface that updates the references.

### `laneyard.yml` in the repository — build behavior

Optional, at the root of the repository, versioned with the code. It describes how this project
builds — so it belongs next to the code, like a `bitrise.yml`.

```yaml
fastlane_dir: fastlane
runtime: bundle
timeout_minutes: 60
interactive_default: false
artifact_globs:
  - "build/**/*.ipa"
  - "build/**/*.app.dSYM.zip"
required_secrets:                    # names only, never values
  - MATCH_PASSWORD
  - APP_STORE_CONNECT_API_KEY_ID
```

### Adopting an existing project

Nobody starts from a blank page: a project that deserves Laneyard already uses fastlane. Writing
the `config.yml` block by hand is therefore the wrong first contact.

`laneyard add`, run from the project's folder, inspects what's there — a `fastlane`
folder, including one nested in a monorepo; presence of a `Gemfile` to choose between `bundle`
and `system`; the nature of the project, Xcode or Gradle, to propose artifact patterns; git
remote and current branch — then adds the corresponding block to `config.yml`.

Two requirements on this write:

- **The file is never rewritten in full.** The edit goes through the YAML document, not through
  a parse/serialize round-trip: comments and key order survive. It's the same rule as
  for the Fastfile — a hand-written file must never come out damaged.
- **Nothing is silently guessed.** The command displays what it detected and what it wasn't
  able to work out, and refuses to act if the project has neither a Fastfile nor a git remote,
  with a message that says what to do.

On first use, it also generates a server password and displays it once.

### Precedence and writing

Field by field: the repository's `laneyard.yml`, then the project's block in `config.yml`, then
default values. The two files share the same vocabulary — any field from
`laneyard.yml` can also be written in the project's block, which lets you configure a repository
without adding a file to it. A project-specific `retention` also has its place there and
then takes precedence over the server's.

The interface shows where each setting comes from — a setting coming from the repository
is flagged as such, and changing it produces a git change to commit, exactly like
a Fastfile edit. Settings from `config.yml` are written directly.

Files are watched: a hand-made change is picked up without a restart.
An invalid file is flagged in the interface and the old valid configuration stays active —
never a half-configured startup. **A run in progress keeps the configuration resolved at its
start**, even if its project is changed or removed from the file in the meantime.

**A secret never appears in a configuration file.** These files can only
declare secret names or reference them with `$NAME`.

## Data model

SQLite only contains execution state and secrets. No `project` table: the list of
projects comes from `config.yml`, and runs reference a project by its `slug`. Removing a project
from the file doesn't destroy its history: the runs stay in the database and remain accessible at
their URL `/r/<id>`, but the project disappears from navigation. Putting it back in the file
makes it reappear intact, history included.

### `secret`

| Field | Type | Role |
|---|---|---|
| `project_slug` | text? | Scope: a project, or null for a global secret |
| `key` | text | Environment variable name |
| `value_enc` | blob | Encrypted at rest, AES-GCM, key outside the database |
| `masked` | bool | If true: never shown again in the UI, redacted in logs |

### `run`

| Field | Type | Role |
|---|---|---|
| `project_slug`, `lane`, `platform` | — | What was launched |
| `params` | json | Options passed to the lane |
| `status` | text | `queued` · `preparing` · `running` · `success` · `failed` · `cancelled` · `interrupted` |
| `branch`, `commit_sha` | text | The exact state of the code at build time |
| `trigger` | text | `manual` in v1; the column exists for later |
| `interactive` | bool | This run's mode |
| `queued_at`, `started_at`, `finished_at` | ts | Wait time and actual duration, kept separate |
| `exit_code`, `error_summary` | — | Failure cause extracted from the log |

### `run_step`

| Field | Type | Role |
|---|---|---|
| `run_id`, `idx`, `name` | — | Order and name of the action, from `report.xml` |
| `duration_ms`, `status` | — | From `report.xml`. Spot the slow or failing step |
| `started_at` | ts | Computed by accumulating durations from the start of the run |
| `log_offset` | int? | Position in the log, from live detection. Null if the step wasn't detected |
| `source` | text | `report` or `live` — where the line comes from, see below |

### `artifact`

| Field | Type | Role |
|---|---|---|
| `run_id`, `filename`, `path`, `size` | — | File moved out of the workspace |
| `kind` | text | `ipa` · `apk` · `aab` · `dsym` · `other` |

### Four deliberate absences

- **No `project` table.** Configuration lives in files, never in the database. See
  "File-based configuration".
- **No `lane` table.** Lanes live in the Fastfile. Laneyard reads them through the sidecar and
  caches the result in an `introspection_cache` table (`project_slug`, `config_hash`,
  `payload` JSON, `fetched_at`), one row per project, overwritten on every hash change.
  The hash covers **the whole `fastlane_dir`**, not just the Fastfile: an `Appfile`, a
  `Pluginfile`, or an imported file changes the lanes just as much.
  It's a cache, not a source: a different hash makes it stale immediately, and
  clearing it has no consequence beyond a slower read. The interface therefore can't
  show a lane that no longer exists.
- **No `user` table.** A hashed password in configuration. Multi-user doesn't make
  sense for a personal self-hosted tool.
- **No logs in the database.** One file per run, streamed live then re-read on demand.

## Lifecycle of a run

1. **Trigger** → `queued`. The parameter form is generated from the lane's actual
   signature. The run is created in the database immediately: even while queued, it is visible.
2. **Queue.** One run per project, configurable global limit.
3. **Preparation** → `preparing`. On a project's first run, the workspace doesn't exist yet:
   it's created by a full clone, an operation visible in the run's logs with its own step,
   because on a large repository it takes a while. The initial clone can also be triggered when
   registering the project, which lets you read the lanes before any run. After that, `git fetch`
   then `checkout` in the project's workspace, kept between runs so it's fast, cleanable on
   demand. The SHA is recorded. If the `Gemfile.lock` has changed, `bundle install` runs first.
   Secrets are decrypted in memory and prepared as environment variables.
4. **Execution** → `running`. fastlane is launched inside a pseudo-terminal: it keeps its
   usual colors and display. Every chunk of output goes to three destinations —
   the log file, connected browsers, a buffer for late connections.
5. **End.** The exit code decides. On failure, the error summary is extracted from fastlane's
   error block by the heuristics module. Artifacts are collected, then moved
   out of the workspace to survive the next build.
6. **Cancellation.** `SIGINT` to the process group — fastlane does its cleanup — then `SIGKILL`
   if it persists. Maximum delay per run, 60 min by default.

### Where the step timeline comes from

On every run fastlane writes a JUnit report to `<fastlane_dir>/report.xml`, with one
entry per action: index, name, duration, and detail on failure. Behavior verified on a
real run:

```xml
<testcase classname="fastlane.lanes" name="0: echo inner" time="0.007099"/>
```

This file is authoritative for names, order, durations, and failures. It's read at the end of the
run, feeds `run_step`, then is deleted from the workspace so it doesn't pollute the repository.

During execution, this report doesn't exist yet. Live display therefore relies on
detecting step separators in the output. Of this detection, only one thing is kept:
the **byte offset** where each step began in the log, which feeds `log_offset` and
lets you click a step to jump to the right place — `report.xml` contains no offset at all.
The names and durations from live detection, on the other hand, are thrown away at the end.

Reconciliation is matching by index. If the detection missed a step, the corresponding
offset is null and the jump to the log is simply unavailable for that one: a
visible and harmless degradation.

**When `report.xml` doesn't exist** — a cancelled or expired run, interrupted by a restart, or a
failure before fastlane even launches (clone, `bundle install`) — the lines from live
detection are kept as-is, with `source = live`. The interface then shows that the
timeline is partial. A run that never reached fastlane simply has no steps.

This separation is deliberate: display convenience relies on a fragile heuristic, the
authoritative data relies on a structured format produced by fastlane itself.

### Artifact collection

fastlane's `lane_context`, which holds the output paths, isn't accessible from a
subprocess. Artifacts are therefore collected using **per-project configured file patterns**
(`artifact_globs`), evaluated against the workspace after the run. That's the contract, explicit
and predictable.

When registering a project, default patterns are suggested based on what's detected in
the repository — `**/*.ipa`, `**/*.app.dSYM.zip` for an iOS project, `**/*.apk`, `**/*.aab` for
Android — editable afterwards. No path is ever guessed by analyzing the run's output.

### Non-interactive mode by default

Runs run with `CI=true`. A run that would need input fails immediately with
an actionable message, instead of hanging on an invisible prompt. An "interactive
mode" checkbox at launch, and a per-project setting, reopen the prompts for setup
phases (first use of `match`, device discovery).

The PTY is used in both cases: it gives colored output, fastlane's normal display, and
an escape hatch when a run gets stuck anyway.

The **CI Readiness** screen is what makes a project autonomous. Checklist recalculated on
demand, never automatically — each check has a cost. No item blocks a run: they are
warnings, in line with the heuristics boundary.

| Item | Detection | Proposed remediation |
|---|---|---|
| Repository accessible without a password | `git ls-remote` with a short timeout and `GIT_TERMINAL_PROMPT=0`. Failure or a prompt for input = red. | Form: path to an SSH key, or entering a token stored as a secret. |
| Installable dependencies | Presence of a `Gemfile`, then `bundle check`. Without a `Gemfile`, checks that `fastlane` is on the `PATH` and flags it as a `system` configuration. | Button that runs `bundle install` and shows its output. |
| App Store Connect authentication | Looks for an API key secret (`APP_STORE_CONNECT_API_KEY_*`) or a `FASTLANE_SESSION` in the project's vault. Session only = orange, with an explanation that it expires. | API key form: key ID, issuer ID, `.p8` content. All stored as masked secrets. |
| `match` usable without intervention | Does the Fastfile use `match` or `sync_code_signing` — information coming from the sidecar, not from a textual read? If so: is `MATCH_PASSWORD` present in the vault, and is the `readonly` parameter set to true in the call? | Form to add the secret; for `readonly`, a link to the action in the editor. |
| No action known to block | Cross-referencing the actions listed by the sidecar with the heuristics module's rule table (actions known to wait for input, e.g. `prompt`). | No automatic action: a simple warning indicating that interactive mode will be needed. |

Each item is an independent detection/remediation pair, added one at a time. The rule
table is only consulted for the last item.

### Secret redaction

The values of secrets marked `masked` are replaced in the stream **before** writing to disk and
before WebSocket broadcast. This isn't a display filter: the value never exists in a
log file.

A naive chunk-by-chunk replacement isn't enough: a PTY splits output wherever it wants, and
a secret can end up cut between two chunks. The filter therefore keeps a sliding buffer
at least as long as the longest secret minus one byte, and only releases what can no
longer be part of a match. The corresponding property test must split the test
output at arbitrary positions, or it won't detect anything.

## The hybrid editor

### What "structured" means

The sidecar returns the syntax tree with exact positions. A statement becomes an editable
card **only** if it is a call to a known fastlane action whose arguments are all
literals — symbols, strings, numbers, booleans, arrays, and literal hashes.

Everything else — conditionals, loops, variables, interpolations, blocks, custom methods —
becomes an **unstructured** card: displayed as-is, readable, editable only in text mode.
No attempt at guessing.

Parameter forms are generated from the action's real metadata. The project's plugins
are therefore supported with no extra effort.

### Integrity guarantee

- **Surgical rewriting.** Changing a parameter only rewrites the byte range of that
  statement. The file is never regenerated from the tree — comments, indentation, and gnarly
  Ruby survive intact.
- **Verification after every write.** Reparse plus `fastlane lanes`. If the syntax breaks or
  a lane disappears, the write is rolled back and the old version restored.
- **Backup before writing**, restored automatically if verification fails. A browsable
  version history isn't necessary in v1: git already fills that role once the
  change is committed.

Text mode is a real code editor with Ruby syntax highlighting, not a fallback. Any
change outside the structured frame goes through it, and that's the expected behavior.

### Editing and git

The edited Fastfile lives in the workspace, which is a clone managed by Laneyard. The loop is
therefore: edit, run the lane to check, then commit and push from the interface. A "Changes"
panel shows the diff.

Laneyard refuses any `checkout` over uncommitted changes and flags the workspace's
dirty state in the interface.

## Interface

```
/                 Projects — last run status, Quick run
/p/<slug>         Project
                    ├─ Lanes            read from the Fastfile
                    ├─ Runs             filterable history
                    ├─ Fastfile         hybrid editor + Changes
                    ├─ Secrets          environment variables
                    ├─ CI Readiness     autonomy checklist
                    └─ Settings         configuration file editing
/r/<id>           Run — steps, terminal, artifacts
```

The Settings tab shows the effective values and, for each one, the file it comes from.
Changing a value defined in the repository produces a git change to commit; changing a
server value writes to `config.yml`. A toggle lets you edit the raw YAML directly,
just as the Fastfile editor offers its text mode.

The run screen places the step timeline on the left and the terminal on the right, with
artifacts appearing at the bottom as soon as they exist. The input line is always present:
disabled with its reason shown rather than hidden.

### Notifications

Two channels, both configured in the project's Settings.

**Browser notification.** The browser's `Notification` API, triggered on receiving the
end-of-run event over the WebSocket. No push server, no third-party service, no
system dependency. Accepted trade-off: it only works if a Laneyard tab is
open. That's the real use case — you trigger a build then move on to something else on the same
machine.

**Webhook.** A URL per project, called via POST with a JSON body describing the finished run:
ID, project, lane, status, duration, commit, list of artifacts. This is the hook
point for Slack, ntfy, Discord, or any personal script. Secret values
never appear in it.

A native system notification is explicitly ruled out: it would show up on the build
machine, which nobody is looking at.

### Visual direction

Classic application structure — sidebar, tabs, panels — with a terminal grammar
inside. The retro feel comes through typography and color, not through disguising it as a
fake console.

- Monospace throughout the interface, navigation and labels included.
- Status markers as characters (`✓ ▸ ✗ ○`) rather than icons; lowercase labels; small
  letter-spaced caps for section titles.
- Right angles, one-pixel rules, no shadows, no gradients. Surfaces are distinguished by
  value, not by depth.
- Strictly semantic colors: green for success, amber for in-progress, red for failure, blue as a
  marker. Nothing decorative. The main accent is phosphor green, a theme variable.

Two themes driven by CSS variables: dark by default, light "paper". **The terminal area
stays dark in both.** fastlane emits ANSI colors designed for a black background; re-mapping
them for a light background is a separate undertaking and would misrepresent the real output.

## Error handling

| Situation | Behavior |
|---|---|
| Misconfigured project | Detected at registration and before every run. The run is refused with an actionable message, not buried in a log. |
| Lane failure | Exit code and summary extracted from fastlane's error block, readable without opening the log. |
| Sidecar failure | Lanes become unreadable; CI Readiness flags it explicitly instead of showing an empty list. |
| WebSocket disconnection | The client reconnects and replays the log from its byte offset. No output lost. |
| Server restart during a run | Orphaned runs move to `interrupted` on startup. |
| Disk full | Log and artifact purge according to the server's `retention`, overridable per project. |

## Tests

Underlying constraint: **no real build anywhere in the test suite.**

- **Ruby sidecar** — Fastfile fixtures (simple, monorepo, with plugins, gnarly Ruby) and
  snapshots of the produced JSON. Plus a property test on the round trip: after a structured
  edit, only the targeted byte range has changed and the file still parses.
- **Runner** — a fake `fastlane` executable replays recorded output with a chosen
  exit code. Covers step splitting, redaction, artifact collection, cancellation, and
  timeout, in milliseconds.
- **Redaction** — property test: a secret value present in the output never appears
  in the persisted log.
- **API** — integration tests against a temporary SQLite database and a git repository created
  on the fly (`git init` then committing a Fastfile). Real git operations, fast execution.
- **Frontend** — component tests on generating forms from action metadata; end-to-end
  Playwright flows against the fake fastlane.

## Security

- Listens on the local network, protected by a single hashed password and a cookie session.
- Secrets encrypted at rest, key in a `0600` file outside the database, OS keychain as an option.
- Secret redaction upstream of any persistence.
- No Internet exposure planned; a tunnel remains possible but is up to the user.

## Publishing

The repository is public from the start. Onboarding documentation is a v1 deliverable, not a
project-end task: a self-hosted tool nobody knows how to install doesn't exist.

**MIT license**, like fastlane itself. No friction for anyone who wants to try it.

### `README.md`

1. **One sentence and a screenshot.** What it is, shown before it's explained: the run in
   progress, with its steps and its terminal. A second screenshot for the Fastfile editor.
2. **Why.** The problem — depending on a billed service that holds your signing chain.
3. **Position the tool.** A short table against Bitrise, Codemagic, and self-hosted GitHub
   Actions: what Laneyard does, what it deliberately doesn't do, and for whom. A reader must be
   able to conclude "this isn't for me" in thirty seconds — that's a service being done for them.
4. **Installation.** Prerequisites (Node, Ruby, fastlane in the project), installation, first
   startup, declaring a first project in `config.yml`, installing as a service.
5. **Configuration.** The two files, commented, as complete examples.
6. **Security.** An explicit, non-buried section: designed for a local network, not to be
   exposed on the Internet; what the vault contains, how it's encrypted, where the key lives;
   the fact that secrets are redacted from logs. A user must know what they're entrusting to the
   tool.
7. **Project status and known limitations.** Honesty about what doesn't exist yet is worth more
   than a disappointed issue.

### `CONTRIBUTING.md`

The architecture in one page — the sidecar's role above all, which is the non-obvious point of
the project — how to run the tests without a build machine, and two guided recipes: adding an
item to the CI Readiness checklist, adding a heuristics rule. These are the two extensions a
contributor will want to make first, and the two places where the isolated module must be
respected.

## Milestones

The v1 scope covers five largely independent subsystems — Ruby sidecar, PTY runner,
secrets vault, hybrid editor, interface. The implementation plan must aim for a **vertical
slice as early as possible** rather than a stack of layers:

1. **The full thread.** Declare a project in `config.yml`, clone it, list the lanes via the
   sidecar, trigger a lane, watch the logs live, retrieve an artifact. File-based configuration
   comes first: it's the foundation for everything else, and writing it later would mean
   tearing down an already-written persistence layer.
2. **Run reliability.** Redaction, queue, cancellation, timeout, interrupted runs,
   timeline from `report.xml`.
3. **Secrets and CI Readiness.** The vault, then the checklist items one by one.
4. **Editor.** Text mode first, with verification and backup, then only after that the
   structured view — text mode alone is already useful, the reverse isn't true.
5. **Polish and publishing.** Notifications, purge, themes, service installation, then
   README, CONTRIBUTING, and license — written last, once the screenshots show the real
   product, but before any announcement.

## Open decisions

- Exact format of the `launchd` and `systemd` units, and the shape of the `laneyard install`
  command.
- Default purge policy, to be confirmed in practice: initial proposal of 50 runs kept
  per project and 30 days of retention for artifacts, with logs following their run.

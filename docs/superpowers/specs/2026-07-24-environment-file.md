# The environment file

Date: 2026-07-24
Status: approved, not implemented

## The problem

A project's own `.env` — the one the app reads, not the one fastlane reads — is
gitignored. Laneyard builds from a clone, so it is never there.

The vault does not solve it. A stored secret becomes an environment variable of
the run, which is enough for fastlane (it reads `ENV`) and enough for a Fastfile
that forwards values itself:

```ruby
sh "flutter build ipa --dart-define=API_URL=#{ENV.fetch('API_URL')}"
```

It is not enough for anything that reads a **file**: `flutter_dotenv` bundles
`.env` as an asset, `--dart-define-from-file=config.json` reads a path at compile
time, an `.xcconfig` is a file by definition. No environment variable stands in
for one, and the build does not fail loudly — it produces an app with empty
configuration.

## The shape

**Each secret carries a tick: *in the environment file*.** One list, no second
place to enter a value. A variable both fastlane and the app need is stored once
and ticked.

**The path is a setting, not a vault row.** Configuration lives in files here —
that is what makes backing Laneyard up a matter of copying one — and where a
build writes a file is build behaviour, the same kind of fact as
`artifact_globs`. So it is `env_file` in `laneyard.yml`, with the server block in
`config.yml` as the fallback for a repository you would rather not touch. Absent
means off, which is the default, and a project that never sets it sees no change
anywhere.

```yaml
# laneyard.yml
env_file: .env
```

Two questions this settles by construction:

- *what goes in the file?* Everything ticked. There is no picker to keep in step
  with the secrets list, because the tick is made where the variable is created,
  while the author still knows what it is for.
- *did I forget one?* The block renders the file it will write, on screen, masked
  values as `••••`. A missing line is visible; an unticked box is not.

```
Environment file   .env                    from laneyard.yml

Written at run time:
  API_URL=https://api.example.com
  MAPS_KEY=••••
  SENTRY_DSN=••••
```

The panel is read-only about the path — it says where the file goes and which
file said so, the way every other resolved setting is reported. What it is there
for is the body underneath.

Nothing is required. A project whose Fastfile forwards values with `ENV.fetch`
leaves the block off and is served by the vault as it is today.

## The file

**Path**, relative to the app root — the directory holding `laneyard.yml`, so a
monorepo needs no extra notion. `normaliseAppConfig` already collapses
app-relative paths into repo-root-relative ones for `fastlane_dir` and
`artifact_globs`; `env_file` joins them, and nothing downstream learns a new
rule. A path climbing out of the workspace is refused at load, so an invalid
value is reported the way every other bad setting is and the last good
configuration stays live.

**Content** is dotenv: `KEY=value`, one per line, sorted by name so a diff of two
runs is readable. A value containing a space, a quote, a `#`, or a newline is
written double-quoted with `\` escapes; one that does not is written bare, so the
common file looks like a file a person wrote.

Dotenv is the only format for now. A `format` field exists in the model from the
start, for `config.json` (`--dart-define-from-file`) and `.xcconfig` later. It is
not in the interface.

**Lifetime** is the one `gradle-properties.ts` already established, and this
spec adopts it rather than inventing a second:

- the first line is `# written by laneyard, do not commit`;
- the file is written when the run starts and removed when it ends, however it
  ended;
- a sweep at the start of the next run removes a marked file left by a server
  killed mid-build;
- **a file without the marker is never written over and never removed.** It is
  the user's own, possibly the working `.env` of a clone they set up by hand, and
  clobbering it would be worse than anything Laneyard could report. The run
  proceeds and says the file was left alone.

The marker is also why dotenv comes first: `#` is a comment there and JSON has no
comment syntax, so `format` will have to answer that question when it arrives.

## What does not change

**Secrets still reach the run as environment variables**, ticked or not. The tick
decides membership of the file and nothing else — a one-sentence definition, and
the reason a variable never has to be entered twice.

**Readiness is untouched.** It asks whether the names a lane reads are in the
vault. These are ordinary secrets, so an `ENV.fetch` that reads one is ticked
green with no change to a single check.

**Log redaction is untouched.** A masked value stays masked; it now also appears
in a file inside the clone, which is why that file is removed at the end of the
run.

## Anticipating the lane scope

Not built here. Each secret carries a `lanes` field from the start — empty means
every lane of the project — stored and resolved, absent from the interface. When
it arrives it needs a lane filter at the point where secrets are collected for a
run, and the environment file inherits it for free: the file is rendered from
the secrets that apply, and by then that set is already lane-aware.

Two levels only, inside a project: global to the project, or one named lane.
The spec removing the cross-project scope
(`2026-07-24-project-scoped-vault.md`) is what keeps it to two.

## Testing

- a project with the block off writes nothing;
- the rendered file matches the preview shown in the interface, byte for byte
  apart from the masking;
- a value with a space, a `#`, a `"` and a newline round-trips through a dotenv
  parser;
- an unmarked file at the path is left untouched, and the run says so;
- a marked file left behind by a previous run is swept before the next starts;
- the file is gone after a run that failed, and after a run that was cancelled;
- a path escaping the app root is refused at the API, not only in the browser.

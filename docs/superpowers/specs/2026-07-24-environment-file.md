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

**Each project carries one environment-file block**: on or off — off by default —
and a path. A project that leaves it off sees no change anywhere.

Two questions this settles by construction:

- *what goes in the file?* Everything ticked. There is no picker to keep in step
  with the secrets list, because the tick is made where the variable is created,
  while the author still knows what it is for.
- *did I forget one?* The block renders the file it will write, on screen, masked
  values as `••••`. A missing line is visible; an unticked box is not.

```
Environment file                 ☑ on
Path   .env

Written at run time:
  API_URL=https://api.example.com
  MAPS_KEY=••••
  SENTRY_DSN=••••
```

Nothing is required. A project whose Fastfile forwards values with `ENV.fetch`
leaves the block off and is served by the vault as it is today.

## The file

**Path**, relative to the app root — the directory holding `laneyard.yml`, so a
monorepo needs no extra notion. A path climbing out of that root is refused when
it is typed, not when the run starts: the value comes from a form, and a run must
never be able to drop a file anywhere on the server. Same rule as
`properties_path` in `gradle-properties.ts`.

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

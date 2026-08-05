# The build number

Date: 2026-08-05
Status: implemented in 0.10.0

## The problem

Every store wants a build number that only ever goes up, and nothing hands one
to a lane. So each project invents the same counter: a file in the repository,
read, incremented, written back, committed and pushed by the lane itself — a
build that writes to its own git remote to remember how many times it has run.

Laneyard already counts runs. It knows a number that goes up, per project,
without asking the repository to store anything.

## The shape

**`LANEYARD_BUILD_NUMBER` is in the environment of every run.** No setting, no
key to add to `laneyard.yml`, nothing to turn on. A project uses it where it
needs it, or ignores it and nothing changes:

```ruby
build = ENV.fetch("LANEYARD_BUILD_NUMBER")
flutter("build ipa --release --build-number=#{build}")
```

The name is fixed and the value cannot be overridden — it sits with `CI` and
`FASTLANE_SKIP_UPDATE_CHECK`, after the secrets, so no stored variable of that
name can shadow it. A number a build could rewrite would not be a counter.

**One counter per project.** Run ids are global — a run of another project
between two of yours would leave a hole — and a build number belongs to the app,
not to the server that built it. So a table keyed by slug, starting at 1.

**Reserved when the run starts, consumed whichever way it ends.** A cancelled
run still waiting in the queue takes no number: it never started. A run that
fails takes one and keeps it. Skipping a number costs nothing; reusing one after
a run that failed *between* two store uploads is a rejected release.

**The next number is editable.** It is the one piece of this that has to be
reachable: migrating from a counter a repository already kept, correcting after
a manual upload, or seeding after moving to another machine. So the project page
shows it and lets an admin set it — state, edited where state is edited, unlike
the settings that live in files.

```
Next build   58   modify
```

The number a run consumed is on the run: `run #42 · build 57`. Without it, the
number in the log would be the only record of what a downloadable artifact
contains.

## What it is not

Not a version. `LANEYARD_BUILD_NUMBER` is the integer that increases; the
marketing version stays wherever the project already keeps it.

Not written back to the repository. Nothing here commits, tags or pushes — a
project that wants a tag still runs `git tag` in its lane, with the number it
was handed.

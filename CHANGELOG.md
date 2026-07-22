# Changelog

## 0.4.0 — unreleased

Signing credentials stop being strings. Everything below is the difference from 0.3.0.

### A signing credential is a file and the fields that go with it

Until now a credential was a string in a flat list, and two of them did not fit. An Android keystore
is bytes that Gradle reads through a path, so there was no string to store; a `.p8` is useless
without the key id and the issuer id that belong with it, and three loose rows in a list say nothing
about the fact that they are one credential.

They are blocks now — the file, plus the handful of fields that make it usable, stored encrypted and
taken whole or refused. A keystore stored without its alias is not a partial success; it is a build
that fails in a month with an artifact nobody can install. Three kinds: an App Store Connect key,
an Android upload keystore, and a Play Store service account, each in the signing part of a
project's Secrets tab.

A block becomes real files for the length of one run, written into the run's own directory at mode
`600` and removed when the run ends, whatever it ended as. Every applicable block is written whether
or not the lane looks like it needs one: a Fastfile can reach anything through `sh` or a plugin, and
a detector that decides "not needed" and is wrong does not cost a warning, it costs a debug-signed
artifact.

None of this is a gate. fastlane is not only for shipping to stores — lanes take screenshots, run
tests, sync certificates — so a project that signs nothing sees three untouched circles rather than
three things it is failing.

### The names a block exports are your project's, not Laneyard's

Each block's form arrives pre-filled with the names fastlane itself declares, and every one of them
is editable. A Fastfile written around `ENV.fetch("ASC_KEY_FILEPATH")` is not a Fastfile doing it
wrong: that name is said on the form, and nothing in the repository is asked to change. Asking at
configuration time is allowed; requiring a repository change is not, and that is the line the whole
of this work is drawn along.

The name stored with the block is the only name exported. Emitting the default alongside it as a
courtesy was tempting and would have been a trap — it is exactly what makes a typo in the configured
name look like it worked, until the day the block is renamed.

### The Android release that ships signed with the debug key

The checklist already caught this and could only tell you about it. The Flutter documentation's own
build script signs with the release config when `key.properties` exists and with the debug config
when it does not, and the same documentation gitignores `key.properties` — so on a build server it
is always absent, the build succeeds, and the store rejects the artifact minutes later saying
nothing about signing.

The obvious fix is to tell the user to rewrite their build script. Laneyard does not do that. It
writes the file the script is already looking for, out of the keystore block, for the length of the
run — where the script looks for it, marked `# written by laneyard, do not commit`, and removed
when fastlane stops. A file of your own without that marker is never written over and never deleted:
it is probably your real signing configuration, and clobbering it would be worse than anything
Laneyard could have warned about. A run killed before it could clean up leaves a marked file behind,
so the next run sweeps for one before it starts.

Two things about that file cannot be read out of a build script, and both are asked on the block
rather than assumed. Where it goes, when the script names it on a receiver the parser cannot follow
— and Laneyard writes nothing rather than picking the likelier of two directories, because a file
sitting in the wrong one looks like the problem has been dealt with. And what the keys inside it are
called, which the script reads out of a `Properties` object indexed by string, somewhere no parse
reaches. Those start from the Flutter documentation's four and are corrected in one keystroke.

### `APP_STORE_CONNECT_API_KEY_P8` never worked

This one is ours. An earlier version of the secrets screen asked people to store their `.p8` under
that name, and no action in fastlane has ever declared it — it appears nowhere in fastlane 2.237.
The value was stored, encrypted, listed, and no lane could see it. Worse, the readiness check
prefix-matched `APP_STORE_CONNECT_API_KEY`, so it went green.

The name is gone from the interface and from `secret import`. A value already in the vault under it
is now reported as doing nothing, rather than ticked or silently ignored: being told to redo five
minutes of work beats a screen that has quietly stopped mentioning it. The `.p8` belongs in an App
Store Connect key block, with the key id and the issuer id it needs.

### Readiness says what Laneyard will do, not what you must change

The keystore line used to advise storing the passphrase loose and reading it in the lane with
`storePassword: ENV["ANDROID_KEYSTORE_PASSWORD"]` — a Fastfile edit, and so not Laneyard's to ask
for. The checks now recommend a block, and describe what happens next: the file is written for the
length of a run, the names it exports are the block's, and the properties file the Android build
wants arrives where the build looks for it, with its keys named on screen rather than left implicit.

Both routes into the vault answer. A project that stored `SUPPLY_JSON_KEY` before blocks existed is
still ticked, because fastlane reads it exactly as it did.

One thing the checks deliberately do not do is read their own writing. `key.properties` written by
a run is a file Laneyard put there, and a check that saw it and reported the project ready would be
reporting on itself.

### The secrets screen is three zones

Variables, secrets, and signing. The first two are the tick box that was already there — `masked`
means "keep this out of the build log", and a value carrying it is never sent back to a browser —
made into a line on the screen rather than a flag on each row. The third holds the blocks, and is
plainly labelled as being for the lanes that sign and upload.

A stored block shows its file name and, for the fields that are not settings, whether each is
stored. Nothing else: the server never sends a field value back, not a keystore password and not an
issuer id, so replacing a block means giving it again in full. That is the honest consequence of
taking it whole.

### `secret import` stops inventing a home for a `.p8`

It mapped `ASC_KEY_FILEPATH` and its two spellings onto the name above, which meant an import
cheerfully stored a private key somewhere nothing would ever read it. It now finds the file, says
where it belongs — an App Store Connect key block, with its key id and issuer id — and stores
nothing for it.

The closing advice was inverted too. It used to say your lanes still read the path forms and should
be pointed at contents instead. They should not: `key_filepath:` and `json_key:` are the supported
forms, and a block puts a real file back on disk precisely so that a lane naming a path keeps
working unedited.

### Anyone can change their own password

Reached by clicking your name in the header. A builder included: it is about one person, not about
the server's list of people, so it does not live behind the admin-only accounts screen. The current
password is asked for even though a session already proves who you are — a session is a cookie in a
browser that may have been left open. Doing it ends every other session that account has, and keeps
the page you did it on signed in.

Until now the only password anyone had was the random one `laneyard setup` prints once, and the
only way to replace it was for an admin to overwrite the account.

### Readiness catches a release that would be signed with the debug key

The one failure on this list that is silent. Everything else fails loudly — a run stops, a
credential is missing, a lane waits. This one *succeeds*: the Flutter documentation's own snippet
signs with the release config when `key.properties` exists and with the debug config when it does
not, and the same documentation gitignores `key.properties`. On a build server it is therefore
always absent, the `.aab` comes out signed with the debug key, and the rejection arrives from the
store minutes later saying nothing about signing.

The Gradle file is read as text — running someone's build script to ask it a question is not
something a checklist may do — so it errs towards saying nothing rather than inventing a verdict.

### The names a project needs are offered, never their values

The secrets screen now puts the missing names up with a field beside each: read by a lane, named in
a committed `.env.example`, or listed under `required_secrets`. Values are typed by a person and
read from nowhere — the file that holds the real ones is the file that never reaches a clone, which
is the problem being reported rather than a source. The computation is shared with the checklist, so
the two cannot come to disagree about what a project needs.

### A value you never called a secret can be read back

The vault was write-only, full stop: no route returned a value, so the interface had nothing to
uncover. That stays true for anything masked — the server refuses it whoever asks.

But not everything in there is a secret. An `APP_VERSION` or a `SENTRY_ORG` is an identifier, and
being unable to check what an import stored makes the import an act of faith. Those are shown on
request, one named key at a time, never in a listing. `mask` and `unmask` flip which a value is
without touching it, because otherwise reading one would have meant retyping it first.

### A lane's own git commands work, and fail fast when they cannot

A Fastfile that bumps a build number and pushes it is ordinary, and that `sh("git push")` inherited
none of the care Laneyard takes with its own git calls. It got the worst failure available: a push
needing a credential did not fail, it waited, and the run sat there until its timeout with nothing
in the log to say what for.

Runs now carry `GIT_TERMINAL_PROMPT=0` and the SSH command built from the project's `git_auth` — the
key that clones a remote is the key that pushes to it. A commit identity is supplied only when the
workspace has none, so a server with no global git configuration stops failing with "Please tell me
who you are" while any identity that does exist still wins.

### The two file credentials are listed once

`APP_STORE_CONNECT_API_KEY_P8` and `SUPPLY_JSON_KEY_DATA` appeared both in the secrets list and in
the "from a file" rows, and the two lines did not offer the same controls. They are only in their
own rows now, which carry removal as well.

### `laneyard secret import`

Typing eight values into a web form to reproduce a file that is already on disk is a poor way to
start, and the sort of chore where one typo costs an evening. This reads a project's
`fastlane/.env` and stores what it finds.

It runs from the CLI, not the server: the `.env` exists where the working copy is, and the server
only ever sees a clone. A variable naming a `.p8` or a service account JSON has the file's
**contents** stored under the name fastlane looks for, because a path does not travel. It shows
what it would do first, in names only, and writes nothing without `--yes`.

### Readiness stops ticking the Android keystore from absence

"no lane builds with gradle" was a tick for any project building through `flutter build appbundle`
or react-native — both of which run gradle underneath, with the signing configuration in
`build.gradle` or `key.properties` where no Fastfile shows it. The check only runs for projects
that build for Android, so seeing no gradle call means the build is driven by something else, not
that no keystore is needed.

### Setup updates an entry instead of refusing it

It printed "Continuing replaces its entry" and then threw `A project already uses the slug`. The
one way to correct an entry written by an older version — running setup again — was the one thing
that could not be done. It updates field by field now, leaving anything the entry carried that
setup knows nothing about: a `git_auth` pointing at an SSH key, a raised `timeout_minutes`.

### Readiness checks the variables the lanes read

The commonest way a project that works on a laptop fails on a build server: the variables live in
`fastlane/.env`, that file is gitignored, and it never reaches the clone a build runs from. The run
stopped at the first one with nothing on screen to explain it.

Every `ENV.fetch("…")` a lane reaches — including through the methods it calls — is now collected
and looked up in the vault. A committed `fastlane/.env.example` is read too, because it names the
variables no parse can find: `sentry-cli` reads `SENTRY_AUTH_TOKEN` from the environment and the
Fastfile never mentions it. `required_secrets` in `laneyard.yml` covers the rest, and is no longer
a field the schema accepted and nothing used.

### The machine's file keeps what it takes to read a project

`laneyard setup` writes `laneyard.yml` into the working copy, and Laneyard builds from a clone of
the remote — so between the end of setup and a `git push`, a project whose fastlane folder is not
at the root was unreadable, with an ENOENT for an explanation. A moment later the same gap failed
again one field along: `runtime` defaulted to `bundle`, and a project using a system fastlane got
"Could not locate Gemfile".

`fastlane_dir` and `runtime` are now written to `config.yml` as well, and only when they are not
the defaults. The repository file still wins the moment it lands — that is the precedence
`config.yml` already documented. The rest of build behaviour stays in the repository.

### Sessions survive a restart, and closing the browser

Sessions lived in a Map, and the cookie had no expiry. Restarting the server to pick up an edit to
`config.yml` signed everybody out; so did quitting the browser. They are in the database now, with
a thirty-day life, and only a SHA-256 of the token is stored — a copy of `laneyard.db` is a list of
digests, not a ring of working keys.

### An improved sidecar no longer serves what the old one concluded

Introspection was cached on the fastlane folder's contents alone. Teaching the parser to follow a
lane into its methods changed what a Fastfile means without changing the Fastfile, so every install
with a warm cache went on being served the old reading. The sidecar's own digest is part of the key
now, so there is nothing to remember to bump.

### Two credential checks that disagreed about one situation

A lane supplying its own App Store Connect key was told "could not tell"; the same lane supplying
its own Play Store service account through `json_key: ENV.fetch("…")` was told it had no credential
at all. The parser kept literal argument values and dropped everything else — losing the fact that
the argument had been passed. It now reports which keywords a call was given, whatever their
values, and the two checks answer alike.

### Readiness reads a Fastfile the way it is actually written

The checks only ever looked inside lane bodies. A Fastfile that factors its work into methods —
`lane :release do deploy_ios end`, with the upload inside `def deploy_ios` — looked from here like a
Fastfile that called no actions at all. The Play Store check then reported, in green, "no lane
uploads to the Play Store" for a project that uploads on every run.

Lanes are now followed into the methods the Fastfile defines, including module methods
(`Helpers.ship`) and chains of them, with a cycle guard.

Two shapes stay out of reach: `import`/`import_from_git`, and custom actions in `fastlane/actions/`.
Those are now **reported** rather than silently skipped, and any check that would have concluded
something from finding nothing answers *could not tell* instead. A wrong warning gets argued with; a
wrong tick gets believed.

### Platform detection follows the Fastfile in a monorepo

`app/fastlane/Fastfile` beside `app/ios/Runner.xcodeproj` reported "no Xcode project and no Gradle
build": the markers were looked for from the repository root, three levels up. They are looked for
beside the Fastfile now, which is where an app keeps them.

### Readiness says at a glance how much needs you

A count above the list, and the unsettled lines carry an edge in their own colour while the settled
ones give up their emphasis. Nothing is reordered — the order is what keeps the screen stable
between runs.

### Removing a project looks like what it is

It was announced in the same small grey capitals as every other section. It is now enclosed in a
bordered region, and says once, in the page's brightest text, that it cannot be undone.

### The two file credentials are told apart

"or from a file — app store connect key, play store service account" ran two platforms together in
one sentence. One row each now, under its platform, showing the name each is stored under and
whether it already is.

### Readiness looks past its own vault for a store credential

A project that configured fastlane years before it met Laneyard was told it had no App Store
Connect key and no Play Store service account, because the only place either check looked was
Laneyard's vault. A false warning is worse than none: it is the one that teaches you the screen is
wrong. Now both checks read the Fastfile's literal arguments, the repository, and fastlane's own
`Appfile` — `json_key_file`, `json_key_data`, `apple_id`.

The vault stays the only thing that earns a tick. Everything else is reported as *could not tell*,
because a path in an Appfile says a credential was arranged, not that the file is on this machine.

### Ctrl-C during `laneyard setup` says so

It printed node's own "Detected unsettled top-level await" complaint and a stack trace at someone
who had just pressed Ctrl-C. It now prints one sentence, writes nothing, and exits 130.

## 0.3.0

0.2.0 was published with a broken sidecar path: listing a project's lanes failed on any
installed copy. If you have it, upgrade.

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

### Added

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

### Fixed

- **Editing `config.yml` no longer rewraps lines nobody touched.** Adding or removing a project
  serialized the document at YAML's default width, folding the password hash across two lines. The
  file still parsed, which is exactly why it went unnoticed until someone opened it.
- **Listing lanes never worked from an installed copy.** The sidecar script was located two levels
  above its module, which is right when running from the sources and wrong once built — an
  installed Laneyard looked for it in `dist/ruby/` and reported "No such file or directory". Both
  0.1.0 and 0.2.0 are affected: the feature the whole tool is built on was broken for everyone who
  installed it, and worked perfectly for the one person running it from a checkout.

### Changed

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

# Laneyard

**A self-hosted web UI for fastlane.**

Laneyard is a browser interface for the fastlane lanes you already have, running on hardware you
own. Pick a lane, click run, watch the output stream, download the artifact. Nobody else holds
your signing keys, and nobody meters your minutes.

It replaces neither fastlane nor your Fastfile — it drives them. Your lanes stay exactly where
they are.

![A build running in Laneyard: step timeline on the left, live output on the right, artifacts below](https://raw.githubusercontent.com/martinfrouin/laneyard/main/docs/screenshots/run.png)

## Why

**You keep the keys.** Signing certificates, keystores, provisioning profiles, store
credentials — everything needed to publish under your name — stays on your machine. A hosted CI
is a third party holding all of it.

**Minutes stop existing.** Hardware you already own costs less than a year of most CI plans,
and never bills by the second. Long builds stop being a budget decision.

**It is just fastlane.** No new DSL, no YAML dialect, no vendor config to port. Laneyard reads
the Fastfile you already have and asks *your* fastlane what it can do — plugins included. It
hard-codes no knowledge of fastlane at all, so upgrading fastlane or adding a plugin needs no
change here.

## Where it fits

|                              | Laneyard    | Hosted CI    | Self-hosted runner |
| ---------------------------- | ----------- | ------------ | ------------------ |
| who holds your signing keys  | you         | the vendor   | you                |
| cost per build               | electricity | per minute   | electricity        |
| setup                        | one command | a signup form| a weekend          |
| works offline                | yes         | no           | yes                |
| build queue across a team    | yes, serial | yes          | yes                |
| runs on pull requests        | planned     | yes          | yes                |

Laneyard's queue is serial: runs are drained one at a time across every project, in the order
they were asked for. If your team needs parallel builds across a fleet today, use something else.
Laneyard is for one machine you control.

## Requirements

- **Node 22 or newer** — the server.
- **Ruby with fastlane**, either through a project `Gemfile` (recommended) or installed for the
  active Ruby. Laneyard never bundles its own fastlane; it uses your project's.
- **git**.
- macOS or Linux. iOS builds need a Mac, as they always have; Android builds do not.

## Install

```bash
npm install -g laneyard
```

Then, from a project you already build with fastlane:

```bash
cd ~/code/your-app
laneyard setup   # answer a few questions about this project
laneyard         # start the server
```

`laneyard setup` inspects what is there — the `fastlane` directory even when nested in a monorepo, a
`Gemfile`, an Xcode project or a Gradle build — and writes the matching block into
`~/.laneyard/config.yml`. On a machine that has no account yet, it also creates the first admin:
it asks what to call it and prints its generated password once. Write it down; it is not shown
again, and nothing stores it.

<details>
<summary>Running from source instead</summary>

```bash
git clone https://github.com/martinfrouin/laneyard.git
cd laneyard
npm install      # builds on install
npm link         # puts `laneyard` on your PATH
```

</details>

Open it from any machine on your network, sign in, and your lanes are listed — because Laneyard
asked your project's own fastlane for them.

![The project screen: lanes read from the Fastfile, with their descriptions, and the run history](https://raw.githubusercontent.com/martinfrouin/laneyard/main/docs/screenshots/project.png)

## Configuration

All configuration lives in files. The database holds execution state only, so backing up
Laneyard means copying one file, and restoring it means copying it back.

### `~/.laneyard/config.yml` — the server and its projects

```yaml
server:
  port: 7890
  bind: 0.0.0.0
  users:                         # written by `laneyard setup`, see Accounts
    - { name: martin, role: admin, password_hash: "scrypt$…" }
    - { name: lea, role: builder, password_hash: "scrypt$…" }
  max_concurrent_runs: 1         # only 1 is accepted, see below
  retention: { runs: 50, artifact_days: 30 }

projects:
  - slug: cartes-ios
    name: Cartes iOS
    git_url: git@github.com:you/cartes.git
    default_branch: main
    git_auth: { kind: ssh_key, ref: ~/.ssh/id_ed25519 }
```

`max_concurrent_runs` accepts `1` and nothing else. Runs are drained from a single queue, one at
a time across every project — parallel runs would need a working directory per run, which does
not exist yet. A larger number is refused when the file loads rather than silently ignored, so a
server is never configured for builds that never happen.

### Accounts

Everyone who signs in has a name, a password and one of two roles. Two, because a third role is
easy to add and impossible to remove.

| | **admin** | **builder** |
|---|---|---|
| start a build, watch it, cancel it | ✓ | ✓ |
| download artifacts, read logs and the Fastfile | ✓ | ✓ |
| see the readiness checklist | ✓ | ✓ |
| read and write secrets | ✓ | |
| save, commit and push the Fastfile | ✓ | |
| remove a project | ✓ | |
| manage accounts | ✓ | |

A builder is what you give someone who ships without being trusted with the signing chain: they
can press the button and watch what happens, and they never see a credential.

The interface shows a builder only what a builder can use — the secrets, fastfile and settings
tabs are not drawn, and neither is the accounts screen. That is courtesy, not security: the
server refuses those routes on its own, whatever the browser was shown, and the test suite
proves it for every verb and every spelling of the address.

Add and remove accounts from the accounts screen, or from the command line:

```bash
echo "$PASSWORD" | laneyard user add lea --role builder
```

The password is read from standard input, never taken as an argument — an argument lands in your
shell history. Without `--role`, the account is a builder.

Two things are refused, in the API and on the command line alike: removing the last admin, and
demoting the last admin. A server nobody can administer cannot be repaired from the interface.

Anyone changes their own password from **your account**, reached by clicking your name in the
header — a builder included, since that page is about one person rather than about the server's
list of people. It asks for the current password even though you are already signed in: a session
is a cookie in a browser that may have been left open on a desk. Doing it ends every other session
that account has, and leaves the page you did it on signed in. That is how the random password
`laneyard setup` printed once stops being a string on a sticky note.

Removing an account ends its sessions immediately — "remove the account" and "revoke access" are
the same act. So does editing `config.yml` by hand: every request looks the account up again, so
a demotion takes effect at once rather than at the next restart.

**Upgrading from 0.2.** An existing `server.password_hash` keeps working, unedited. It is read as
a single admin account called `admin` — sign in with that name and the password you already have.
The first time you add someone, the file is rewritten into the `users` form above, comments and
all. Do not write both forms: a file holding a `password_hash` *and* a `users` list is refused at
load, because there is no obvious winner.

### `laneyard.yml` — in your repository, and committed

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

It looks **beside the Fastfile**, not at the repository root, because that is where an app keeps
its platform folders: `ios/` and `fastlane/` are siblings, and both move together when the app is
one directory of a monorepo. So `app/fastlane/Fastfile` alongside `app/ios/Runner.xcodeproj` is
found, and a project configured with `ios/fastlane` reports iOS alone rather than being shown the
Android section on the strength of a sibling folder its lanes never touch. When that guess is
wrong, `platforms` is read first and settles it.

Field by field, the repository file wins over the server block, which wins over the defaults. Any
field of `laneyard.yml` may also be written in the server block, so a repository you would rather
not touch can be configured entirely from `config.yml`.

Both files are watched: edit them by hand and Laneyard picks the change up. An invalid file is
reported and the last valid configuration stays live — a typo never takes the server down.

### Secrets

Credentials do not live in a file. They go into an encrypted vault, from the Secrets tab of a
project or from the command line:

```bash
laneyard secret set MATCH_PASSWORD --project cartes-ios   # reads the value from standard input
echo "$GITHUB_TOKEN" | laneyard secret set GITHUB_TOKEN    # global, and out of your shell history
```

The value is never an argument: a command line ends up in `~/.zsh_history` and in the output of
`ps`. Typing the command alone leaves you at a blank line — type or paste the value, then
`Ctrl-D`.

**Reading one back.** The vault is write-only for anything you called a secret: the server never
sends a masked value back, so the interface has nothing to uncover and no browser ever holds one.

Not everything stored here is a secret, though — `APP_VERSION`, `SENTRY_ORG`, an issuer id are
identifiers, and being unable to check what an import stored makes the import something you take on
faith. So the line is the one you drew yourself: a value kept out of the logs is never returned; a
value you stored without that is shown on request, one named key at a time. `mask` and `unmask`
change which it is without touching the value — otherwise revealing something would mean first
retyping the value you were trying to read.

**Bring the ones you already have.** A project that builds today has its variables in
`fastlane/.env` — gitignored, on one laptop, and therefore absent from the clone a build runs
from. From that working copy:

```bash
laneyard secret import --project cartes-ios          # shows what it would store
laneyard secret import --project cartes-ios --yes    # stores it
```

It runs from the CLI because that is where the `.env` is; the server only ever sees a clone. A
variable naming a `.p8` or a service account JSON has the **file's contents** stored, under the
name fastlane looks for — `APP_STORE_CONNECT_API_KEY_P8`, `SUPPLY_JSON_KEY_DATA` — because a path
does not travel to another machine. Everything is masked, and nothing is printed but names.

Your lanes will still read the path forms afterwards. Point them at the contents instead:
`key_content:` rather than `key_filepath:`, and drop `json_key:` so supply reads
`SUPPLY_JSON_KEY_DATA` itself.

**Two of them are files.** An App Store Connect key arrives as a `.p8` and a Play Store service
account as a JSON file, and pasting either into a text field is the moment you are most likely to
paste it somewhere else by accident. The Secrets tab takes the file directly — *app store connect
key* and *play store service account*, beside the value field. Your browser reads it and sends its
text to the same route a typed value goes through, under the name fastlane and the readiness
checklist both look for: `APP_STORE_CONNECT_API_KEY_P8` and `SUPPLY_JSON_KEY_DATA`. Nothing is
uploaded, nothing is written to disk on the way, and the page only ever shows the file's name.

A secret becomes an environment variable for every run of the project it belongs to. Without
`--project` it applies to every project; a project secret of the same name wins over a global
one. Secrets are kept out of the logs unless you pass `--no-mask`, and a masked value must be at
least four characters long — see below.

### Readiness

Every project has a Readiness tab: what stands between it and a build that runs while nobody
watches. Only the checks that apply to the project are shown — an Android project is never asked
for an App Store Connect key, because one irrelevant warning teaches you to ignore the screen.

**What a tick means.** The checks read your Fastfile, following a lane into the methods that
Fastfile defines — factoring your lanes into `def deploy_ios` is good practice, not something that
should make Laneyard blind. Two things stay out of reach and always will: `import`/`import_from_git`
brings in lanes written elsewhere, and `fastlane/actions/` holds actions whose names mean nothing to
a reader that has only seen the Fastfile. Where either applies, a check that found nothing says
*could not tell* rather than ticking. A green tick here means "looked, and it is fine" — never
"looked, and saw nothing".

Always:

- **the repository** answers `git ls-remote` without asking for credentials — a run that meets a
  password prompt does not fail, it waits;
- **dependencies** are installable: `bundle check` against your Gemfile, or the `fastlane` a run
  would otherwise find on the PATH;
- **no lane calls an action known to stop and ask** — `prompt`, `sigh`, `cert`, a writable
  `match`, an upload waiting for its summary to be confirmed;
- **the variables the lanes read** are in the vault. Every `ENV.fetch("…")` a lane reaches is
  collected and looked up. This is the check for the commonest way a project that works on your
  laptop fails on a build server: the variables live in `fastlane/.env`, that file is gitignored,
  and it never reaches the clone a build runs from — so the run stops at the first one with
  nothing on screen to say why.

  Two things a Fastfile cannot tell you, and two places to say them. A variable read by a tool the
  lane shells out to — `sentry-cli` and its `SENTRY_AUTH_TOKEN` — is named nowhere in the lanes. A
  committed `fastlane/.env.example` is read for exactly this, since that is what the file is for,
  and `required_secrets` in `laneyard.yml` covers whatever it does not. A variable found only in
  the server's own environment is reported rather than ticked over: it works, but it works because
  of how this server was started.

On iOS:

- **App Store Connect** has an API key. The vault is checked first and is the only thing that
  earns a tick — but a project that configured fastlane long before it met Laneyard keeps its key
  elsewhere, so the lanes are read for `app_store_connect_api_key` and for a `key_filepath` or
  `api_key_path` argument, and the repository for a `.p8`. Any of those is reported as *could not
  tell*, not as a warning: a path in a Fastfile says a key was arranged, not that the file is on
  this machine. An Appfile holding only an `apple_id` is a warning — that is the account
  two-factor authentication will stop the run to ask about;
- **match** has its `MATCH_PASSWORD` stored and is called `readonly`, so it fetches certificates
  instead of trying to create them.

On Android:

- **the keystore** is reachable without a prompt: a lane handing `gradle` a `storeFile` needs a
  passphrase, and one that is neither in the call nor in the vault makes gradle stop and ask;
- **the release is signed with the release key.** The one check here whose failure is silent:
  the Flutter documentation's own snippet signs with the release config when `key.properties`
  exists and with the *debug* config when it does not — and gitignores `key.properties`, so it is
  absent from every clone. The build then succeeds, produces an artifact signed with the debug key,
  and the rejection arrives from the store minutes later saying nothing about signing. This reads
  the Gradle file as text and says so before the build, not after — and then, for a project whose
  keystore is stored here, writes the `key.properties` that build is already asking for, for the
  length of the run. Your build script is not asked to change: the file arrives where it looks for
  it, marked `# written by laneyard, do not commit`, and is removed when fastlane stops. A file of
  your own without that marker is never written over and never deleted;
- **the Play Store service account** is there when a lane calls `upload_to_play_store`. The vault
  first, then the `json_key` argument in the call, then the **Appfile** — `json_key_file` and
  `json_key_data`, which is where a long-standing project almost always keeps it. Only the vault
  is a tick; the other two are *could not tell*, for the same reason as above.

Like the iOS ones, the Android checks read **literal arguments only**. `gradle(storePassword:
ENV["PW"])` is reported as undetermined, never guessed at: a checklist that guesses gets believed.

They run when you open the tab or press refresh, never on their own: they shell out to git and to
bundler. The time of the last run is on screen, because a stale green tick is worse than a red
cross.

Nothing here blocks anything. A red check is never the reason a run cannot be started, and
Laneyard never edits a Fastfile to make its own checklist go green — each line explains, you
decide. Where the fix genuinely is one action, the line links to the Secrets tab instead of
growing a second copy of its form.

**What it cannot see.** The checklist reads *literal* arguments only. `match(readonly: true)` is
green and `match(readonly: false)` is a warning, but `match(readonly: ENV["RO"])` has no value
until the lane runs, so it is reported as undetermined — `○`, with the reason — rather than
guessed either way. The same applies to anything a lane computes: a checklist that guesses gets
believed, and then it is worse than no checklist. Android signing is not covered at all yet.

### The Fastfile

Every project has a Fastfile tab. **It is a text editor** — your file, in a box, with Ruby
syntax highlighting and nothing between you and it. The structured view described in the design
document, where lanes and actions are things you arrange rather than type, is still to come. This
is the honest first half of it, and it is useful on its own: fixing a lane at 2am should not
require an SSH session.

**Every write is verified.** Saving sends the file to the server, which writes it byte-for-byte —
no reformatting, no trailing-newline fixing, no reordering — then asks fastlane to parse it and
list its lanes. If that fails, the previous content is put back on disk before the request
answers, and the reason fastlane gave appears above the editor with your work still in the box.
A broken Fastfile never reaches a workspace a run might build from.

Saving is explicit, never automatic: verification is a Ruby subprocess, not a regular expression,
and an editor that ran it on every keystroke would be both slow and dangerous. `⌘S` is another
way to ask, not an autosave. Laneyard also refuses to write at all while a run of that project is
in flight — that run is reading the very file the write would replace.

Below the editor is what git makes of the workspace: the diff, a message field, `commit` and
`push`. A commit stages exactly the files that changed and never `git add -A` — a build leaves
artifacts and reports scattered around, and none of them belong in your history.

### Removing a project

Every project has a Settings tab, and the one thing on it is removal. It takes the project's block
out of `config.yml` — through the YAML document, so your comments and your key order survive —
and stops showing it. It is confirmed by typing the project's name: it is the one destructive
action in Laneyard, and a dialogue you can click through is not a confirmation.

What it does *not* do is most of the point, because "delete" elsewhere usually means the opposite:

- **the runs stay.** Every build that project ever ran keeps its page, its log and its artifacts,
  each still at its own address. Removing a project means stop showing it, not destroy its past;
- **the clone and the artifacts stay on disk.** Their paths are printed when it is done, so you
  can remove them yourself. Nothing is deleted from a web page on one click;
- **the secrets stay in the vault**, encrypted and unreachable, and come back if you add the
  project again under the same name;
- **the repository is untouched.** Its `laneyard.yml`, its Fastfile and its history are the
  repository's, not Laneyard's.

Removal is refused while a run of that project is in flight — that run is using the workspace. A
run still waiting in the queue will not start: it ends as failed, saying its project is gone.

## Security

Read this before putting Laneyard on a network.

- **It is built for a local network, not the internet.** It listens on `0.0.0.0` so you can reach
  it from your laptop, behind a password. Do not expose it publicly. If you need remote access,
  put it behind a VPN or an SSH tunnel.
- **Passwords** are stored as scrypt hashes and repeated failures are throttled, per account, so
  hammering one name cannot lock out the others. Sessions live in memory and do not survive a
  restart.
- **A role is enforced by the server, not by the interface.** One table names the routes that
  require an admin, and one hook is the only thing that reads it — there is no permission check
  hidden inside a handler. What a builder is not shown is also what a builder is refused.
- **Secrets are encrypted at rest.** Values are stored with AES-256-GCM under a key kept in
  `~/.laneyard/key` — outside the database, mode `600`, and Laneyard refuses to start if anyone
  else can read it. Someone who walks off with `laneyard.db` gets ciphertext. Nothing else in the
  process holds plaintext: the store, the API and the interface deal in names only, and no route
  ever sends a value back — which is why the Secrets tab has no reveal button.
- **Masked values are removed from output before it is written, not when it is displayed.** The
  substitution happens once, at the point where a run's output fans out, so the log file on disk,
  the live stream to your browser and the stored error summary all contain `••••••` and never the
  value. It survives being split across two chunks of terminal output.
- **Do not put secrets in `config.yml`.** It is a plain file with ordinary permissions. Use
  `laneyard secret set` or the Secrets tab.

What this does *not* cover, stated plainly:

- **Git credentials are not in the vault.** `git_auth` points at an SSH key on disk by path;
  token authentication is refused at load time rather than silently ignored, so a project cannot
  be configured for something that never happens. Laneyard removes the configured repository URL
  from its own git error messages — so a token embedded in an HTTPS URL does not leak that way —
  but that is one string, not a vault.
- **A value shorter than four characters is refused, not protected.** Removing a two-character
  string from a log would shred the output while hiding nothing, so Laneyard says no rather than
  pretending. Store it unmasked if it genuinely does not matter.
- **Anything fastlane prints that is not a stored secret is stored in the clear**, under
  `~/.laneyard/logs/`.

## Status

`✓` shipped · `▸` being built · `○` planned

- `✓` declare a project, clone it, list its lanes, run one, watch it live, download the artifact
- `✓` configuration entirely in files you can version and back up
- `✓` adopt an existing fastlane project with one command
- `✓` encrypted secret vault and log redaction
- `✓` build queue, cancellation, timeouts surfaced in the UI
- `✓` a checklist that gets a project running unattended
- `✓` edit the Fastfile in the browser, verified on every save
- `✓` store a signing credential straight from its `.p8` or JSON file
- `✓` remove a project from the interface, without touching its history
- `✓` named accounts, with a builder role that never sees a credential
- `○` git-triggered and scheduled builds

Two things worth knowing today: listing lanes does not fetch the repository, so a lane you have
just pushed appears after the next run; and runs execute one at a time across all projects, so a
build triggered while another is going waits its turn rather than starting alongside it. A queued
run survives a restart of the server — it is still queued when it comes back up, and starts on
its own.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `npm test` runs the whole suite in
seconds against a fake fastlane, so you can work on any machine, with no Xcode, no signing
certificates and no network.

## Licence

MIT — see [LICENSE](LICENSE).

Built on [fastlane](https://fastlane.tools), and not affiliated with it.

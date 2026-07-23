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

The adaptation goes one way. A repository that builds today keeps building unedited: signing
credentials reach your lanes under the variable names your Fastfile already reads, and where
Laneyard needs to know something no file can tell it, it asks on a form rather than asking you to
change the file.

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

Anyone changes their own password from **your account**, which is said in those words in the header
and again on your own row of the accounts screen — a builder included, since that page is about one
person rather than about the server's list of people. It asks for the current password even though you are already signed in: a session
is a cookie in a browser that may have been left open on a desk. Doing it ends every other session
that account has, and leaves the page you did it on signed in. That is how the random password
`laneyard setup` printed once stops being a string on a sticky note.

Removing an account ends its sessions immediately — "remove the account" and "revoke access" are
the same act. So does editing `config.yml` by hand: every request looks the account up again, so
a demotion takes effect at once rather than at the next restart.

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

The variables your lanes read do not live in a file. They go into an encrypted vault, from the
Secrets tab of a project or from the command line — the files a project signs with go in the same
vault, as blocks, and have a section of their own below:

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
variable naming a service account JSON has the **file's contents** stored, under `SUPPLY_JSON_KEY_DATA`
— a name supply reads on its own — because a path does not travel to another machine. A variable
naming a `.p8` is reported and left alone: no action in fastlane reads a `.p8` out of an environment
variable, and that credential belongs in a signing block, described below. Everything stored is
masked, and nothing is printed but names.

Nothing in your lanes has to change afterwards. `key_filepath:` and `json_key:` keep working as
written — a signing block puts a real file back on disk for the length of a run.

A secret becomes an environment variable for every run of the project it belongs to. Without
`--project` it applies to every project; a project secret of the same name wins over a global
one. Secrets are kept out of the logs unless you pass `--no-mask`, and a masked value must be at
least four characters long — see below.

### Signing credentials

A signing credential is not a string. An Android keystore is bytes that Gradle reads through a path,
and a `.p8` is useless without the key id and the issuer id that go with it — so these are stored as
blocks: one file, plus the handful of fields that make it usable, taken whole or refused. A keystore
stored without its alias is not a partial success; it is a build that fails in a month.

| block | the file | the fields beside it |
| ------------------------------ | ---------------------- | ------------------------------------------- |
| *app store connect key*        | `.p8`                  | key id, issuer id                           |
| *android upload keystore*      | `.jks` or `.keystore`  | key alias, store password, key password     |
| *play store service account*   | JSON                   | —                                           |

They live in the **signing** part of a project's Secrets tab, beside the variables and the secrets.
The file is encrypted at rest like everything else in the vault and never comes back out to a
browser: a stored block shows its file name and nothing more, so replacing one means giving it again
in full.

A variable a block has made redundant is said to be so, beside the row and in one sentence:
`SUPPLY_JSON_KEY_DATA` once a Play block applies — it still works, but the same credential is then
stored twice — and `APP_STORE_CONNECT_API_KEY_P8`, which no action in fastlane has ever read.
Neither is removed for you: the row is yours, and the button to drop it is on the same line.

**A block becomes real files, for the length of a run.** Gradle's `storeFile` is a path, and
`app_store_connect_api_key` wants a path, so a credential that exists only as ciphertext in a
database cannot be used by anything. Each block that applies is written into
`~/.laneyard/runs/<run id>/secrets/`, mode `600` in a `700` directory, and that directory is removed
when the run ends — whether it passed, failed, was cancelled or timed out. Every applicable block is
written, whether or not the lane looks like it needs one: a Fastfile can reach anything through `sh`
or a plugin, and a guess of "not needed" that is wrong is a debug-signed artifact rather than a
missing variable.

**It reaches your lanes under the names your project already reads.** Each block's form arrives
pre-filled with the names fastlane itself declares — `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH`,
`APP_STORE_CONNECT_API_KEY_KEY_ID`, `APP_STORE_CONNECT_API_KEY_ISSUER_ID` for the key, and
`SUPPLY_JSON_KEY` for the service account — and every one of them is editable. A Fastfile written
around `ENV.fetch("ASC_KEY_FILEPATH")` is not a Fastfile doing it wrong: you say so on that form,
rather than being asked to rename anything in the repository. The name stored with the block is the
only name exported, and no default is emitted alongside it as a courtesy — that courtesy is what
would make a typo in the configured name look like it had worked.

Nothing in fastlane reads a keystore by convention, so the keystore's names are Laneyard's own —
`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` —
and the same rule applies to them.

**The keystore block can also supply `key.properties`.** The Flutter documentation's own build
script signs with the release config when that file exists and with the debug config when it does
not, and gitignores it — so on a build server it is always absent. Rather than telling you to
rewrite your build script, Laneyard writes the file the script is already looking for, for the
length of the run, out of the keystore block. Two things about that file cannot be read out of a
build script and are asked for on the block instead: where it goes, when the script names it in a
way that leaves the directory unresolved, and what the keys inside it are called, which start from
the Flutter documentation's four. Asking at configuration time is allowed; requiring a change to
your repository is not.

**Only the projects that sign need any of this.** fastlane is not only for shipping to stores —
lanes take screenshots, run tests, sync certificates — so the three blocks are an offer rather than
a gate. A project that wants an artifact out of a Gradle build needs the keystore and nothing else,
and three untouched circles are not three things it is failing.

A block stored on a project belongs to that project. One stored globally applies to every project,
and a project's own block wins over it. Both are admin-only, like the rest of the vault.

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

  A name a signing block exports counts as being in the vault, since that is where the block is:
  a lane reading `SUPPLY_JSON_KEY` with a Play block stored is not asked for it again, on this
  checklist or on the Secrets tab. The two read the same answer.

On iOS:

- **App Store Connect** has an API key. The vault is checked first and is the only thing that
  earns a tick — a signing block, or the variables a project stored before blocks existed, since
  fastlane reads those exactly as it did. A project that configured fastlane long before it met
  Laneyard keeps its key elsewhere, so the lanes are read for `app_store_connect_api_key` and for a `key_filepath` or
  `api_key_path` argument, and the repository for a `.p8`. Any of those is reported as *could not
  tell*, not as a warning: a path in a Fastfile says a key was arranged, not that the file is on
  this machine. An Appfile holding only an `apple_id` is a warning — that is the account
  two-factor authentication will stop the run to ask about. One name is called out rather than
  accepted: a value stored under `APP_STORE_CONNECT_API_KEY_P8` used to earn a tick here, and no
  action in fastlane has ever read a variable of that name — the check now says so, because being
  told to redo the work beats a screen that has quietly gone silent about it;
- **match** has its `MATCH_PASSWORD` stored and is called `readonly`, so it fetches certificates
  instead of trying to create them.

On Android:

- **the keystore** is reachable without a prompt: a lane handing `gradle` a `storeFile` needs a
  passphrase, and one that is neither in the call nor in the vault makes gradle stop and ask. A
  keystore block settles this before the lanes are read at all — the file and both passphrases
  reach the run together, so nothing can stop and ask, whichever lane runs;
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
  first — a block, or a `SUPPLY_JSON_KEY` variable stored before blocks existed — then the
  `json_key` argument in the call, then the **Appfile**: `json_key_file` and `json_key_data`, which
  is where a long-standing project almost always keeps it. Only the vault is a tick; the other two
  are *could not tell*, for the same reason as above.

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
believed, and then it is worse than no checklist. Android signing is read out of the Gradle build
script rather than the Fastfile, since that is where it lives — and read as text, because running
someone's build script to ask it a question is not something a checklist may do.

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

Every project has a Settings tab, and the one thing on it is removal. It removes everything
Laneyard holds for the project, in one confirmed act. It is confirmed by typing the project's
name: it is the one destructive action in Laneyard, and a dialogue you can click through is not a
confirmation.

What it removes:

- **its block in `config.yml`** — taken out through the YAML document, so your comments and your
  key order survive;
- **its run history and its logs.** Every build the project ran, its rows and its logs, deleted.
  This is the one thing here nothing can rebuild, and the reason removal is behind a typed name;
- **the clone and the artifacts on disk**, deleted;
- **its secrets and its signing blocks in the vault** — Laneyard's own encrypted copies, forgotten.
  The screen counts them before you confirm and again once it is done, because they are the one
  thing on this list you cannot go and look at: no route ever sends a credential back.

What it does *not* touch, said as plainly:

- **the git remote.** The repository is on your host and your disk. Laneyard neither reads nor
  writes it;
- **the credential originals.** The `.p8` and the keystore you uploaded are wherever you keep them
  — a password manager, a safe. Laneyard removes only its own encrypted copy; you would upload them
  again from there;
- **global secrets and global signing blocks.** They are read by every project on the machine, not
  this one's to take, and they are left alone. The result names how many it left.

Removal is refused while a run of that project is in flight — that run is using the workspace. A
run still waiting in the queue will not start: it ends as failed, saying its project is gone.

The same thing from the command line:

```bash
laneyard remove cartes-ios --dry-run   # show what would go, and stop
laneyard remove cartes-ios             # remove it, after a typed confirmation
```

It removes exactly what the Settings tab does, leaves exactly what it leaves, and is confirmed the
same way — by typing the project's slug back, not `y`. `--dry-run` prints the inventory and stops.
It is refused for an unknown slug, and while a run of the project is in flight.

### Resetting

```bash
laneyard reset --dry-run   # show what would go, and stop
laneyard reset             # wipe it, after a typed confirmation
```

`laneyard reset` wipes the data and keeps you able to use Laneyard: every project, the database,
the workspaces, the artifacts and the logs go; your accounts and the vault key stay. It is a data
reset that does not lock you out — you sign in with the same names afterwards — and it keeps the
key, so any older `laneyard.db` backup stays readable rather than becoming ciphertext nobody can
open. The database comes back empty from the schema on the next start, which also clears the
sessions, so everyone signs in again.

It keeps the `server:` block of `config.yml` (accounts, port, bind, retention) and
`~/.laneyard/key`. It never touches the git remotes or the credential originals — those were never
Laneyard's. It reads the inventory first and, like `uninstall`, is confirmed by typing the
folder's path, not `y`.

### Uninstalling

```bash
laneyard uninstall --dry-run   # list what is there, and stop
laneyard uninstall             # remove it, after a typed confirmation
npm uninstall -g laneyard      # remove the package itself
```

`laneyard uninstall` removes the data folder: `config.yml`, the vault key, the database, the
workspaces, the artifacts and the logs. It reads the whole inventory from disk first — the
projects, the number of secrets and signing blocks, the real sizes and paths — and prints it
before asking anything.

The vault key is the one loss that cannot be undone. Every secret and every signing block is
encrypted under `~/.laneyard/key`; once it is gone the database is ciphertext nobody can read, and
restoring a backup of `laneyard.db` alone brings nothing back. The originals are yours and are
untouched — the `.p8` in your downloads, the keystore in your safe — so what you are agreeing to
is uploading them again. Global secrets and global signing blocks are shared by every project and
go too; the inventory says so on its own line.

It is confirmed by typing the folder's path, not `y`: this is the one command in Laneyard that
destroys credentials, and `$LANEYARD_HOME` is exactly the case where a reflex is wrong. Anything
in the folder that Laneyard did not put there is named, left alone, and the folder is kept for it.

It does not remove the npm package — a command cannot sensibly delete the binary it is running
from — and it prints the command that does. There is no npm lifecycle hook doing any of this on
`npm uninstall`, on purpose: a package manager must not delete someone's signing keys on its own,
and a lifecycle script cannot ask.

## Security

Read this before putting Laneyard on a network.

- **It is built for a local network, not the internet.** It listens on `0.0.0.0` so you can reach
  it from your laptop, behind a password. Do not expose it publicly. If you need remote access,
  put it behind a VPN or an SSH tunnel.
- **Passwords** are stored as scrypt hashes and repeated failures are throttled, per account, so
  hammering one name cannot lock out the others. Sessions survive a restart, and what is stored is
  a SHA-256 of the token rather than the token: a stolen `laneyard.db` is a list of digests, not a
  ring of working keys.
- **A role is enforced by the server, not by the interface.** One table names the routes that
  require an admin, and one hook is the only thing that reads it — there is no permission check
  hidden inside a handler. What a builder is not shown is also what a builder is refused.
- **Secrets are encrypted at rest.** Values are stored with AES-256-GCM under a key kept in
  `~/.laneyard/key` — outside the database, mode `600`, and Laneyard refuses to start if anyone
  else can read it. Someone who walks off with `laneyard.db` gets ciphertext. Nothing else in the
  process holds plaintext: the store, the API and the interface deal in names only, and no route
  ever sends a value back — which is why the Secrets tab has no reveal button.
- **A signing block is on disk only while a run needs it.** A keystore has no string form, so the
  file is written into `~/.laneyard/runs/<run id>/secrets/`, mode `600` inside a `700` directory,
  and that directory goes when the run ends. The block's secret fields — the two keystore
  passphrases — are removed from a run's output the same way a masked secret is, because gradle is
  perfectly willing to echo one back on failure.
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
- **`key.properties` is written into the workspace, and it holds passwords.** It is the one
  credential Laneyard puts in the clone rather than in the run's own directory, because Gradle
  resolves that path relative to the build. It is mode `600`, carries a marker line as its first
  line, is removed when the run ends, and is swept for again at the start of the next run in case a
  server was killed mid-build. A file of yours without that marker is never written over and never
  removed.

## Status

`✓` shipped · `▸` being built · `○` planned

- `✓` declare a project, clone it, list its lanes, run one, watch it live, download the artifact
- `✓` configuration entirely in files you can version and back up
- `✓` adopt an existing fastlane project with one command
- `✓` encrypted secret vault and log redaction
- `✓` build queue, cancellation, timeouts surfaced in the UI
- `✓` a checklist that gets a project running unattended
- `✓` edit the Fastfile in the browser, verified on every save
- `✓` signing credentials stored whole — the file and the fields beside it — written to disk for
  the length of a run and exported under the names your project already reads
- `✓` remove a project from the interface — everything Laneyard holds for it, behind a typed name
- `✓` `laneyard uninstall`: the whole inventory first, then a typed confirmation, then the folder
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

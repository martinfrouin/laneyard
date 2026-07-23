# Laneyard

**A self-hosted web UI for fastlane.**

A browser interface for the fastlane lanes you already have, on hardware you own. Pick a lane, run
it, watch the output stream, download the artifact. Nobody else holds your signing keys, nobody
meters your minutes.

It drives fastlane, it doesn't replace it. Your lanes stay where they are.

![A build running in Laneyard: step timeline on the left, live output on the right, artifacts below](https://raw.githubusercontent.com/martinfrouin/laneyard/main/docs/screenshots/run.png)

## Why

**You keep the keys.** Certificates, keystores, profiles, store credentials — everything needed to
publish under your name — stays on your machine. Hosted CI is a third party holding all of it.

**Minutes stop existing.** Hardware you own costs less than a year of most CI plans and never bills
by the second. Long builds stop being a budget decision.

**It is just fastlane.** No new DSL, no YAML dialect, nothing to port. Laneyard reads your Fastfile
and asks *your* fastlane what it can do, plugins included — so upgrading fastlane needs no change
here.

The adaptation goes one way. Credentials reach your lanes under the variable names your Fastfile
already reads; where a file can't tell Laneyard something, it asks on a form instead of asking you to
change the file. Every edit it offers is optional — decline them all and the repository builds
exactly as before.

## Where it fits

|                              | Laneyard    | Hosted CI    | Self-hosted runner |
| ---------------------------- | ----------- | ------------ | ------------------ |
| who holds your signing keys  | you         | the vendor   | you                |
| cost per build               | electricity | per minute   | electricity        |
| setup                        | one command | a signup form| a weekend          |
| works offline                | yes         | no           | yes                |
| build queue across a team    | yes, serial | yes          | yes                |
| runs on pull requests        | planned     | yes          | yes                |

Laneyard's queue is serial: runs drain one at a time across every project, in order. If your team
needs parallel builds across a fleet today, use something else — Laneyard is for one machine you
control.

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

`laneyard setup` inspects what is there — the `fastlane` directory (even nested in a monorepo), a
`Gemfile`, an Xcode project or a Gradle build — and writes the matching block into
`~/.laneyard/config.yml`. On a machine with no account yet, it also creates the first admin: it asks
the name and prints a generated password once. Write it down — it is not shown again.

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

### What setup does about a credential your Fastfile names outright

`laneyard setup` has a second act, after `Project "x" is set up` prints. The order is the guarantee:
everything below is offered to a project that already works, so declining it all costs nothing.

It looks for a credential named by a literal value:

```ruby
upload_to_play_store(json_key: "./play-service-account.json", track: "beta")
```

That line builds on the laptop it was written on and nowhere else. Laneyard builds from a clone of
your remote, so the JSON is either gitignored (absent from the clone — the run fails) or committed (a
service account key in your history). Neither is something a checklist can fix later.

So setup reads the Fastfile with Prism and offers — one at a time, refusably — to lift each
credential it recognises into the vault and replace the literal with `ENV.fetch(…)`. It reads the
syntax tree, not text, because `json_key:` also appears in comments and strings: a wrong patch to a
build file is the worst thing this feature could do.

Three kinds, by how sure the reading is:

- **a path to a credential file** — `key_filepath:` on `app_store_connect_api_key`, `json_key:` on
  `supply`/`upload_to_play_store`/`validate_play_store_json_key` — offered only when the path
  resolves to a file on disk. Defaults to yes. A `key_id:` or `issuer_id:` written beside an adopted
  key is carried with it, rewritten to the variable the block exports and used to pre-fill its fields;
- **the credential's contents, inline** — `key_content:`, `json_key_data:`, a private key in
  cleartext. Defaults to yes. The patch renames the keyword too — `key_content:` becomes
  `key_filepath:`, `json_key_data:` becomes `json_key:` — because a stored block is exported as a
  *path*, not text;
- **an argument that looks like a secret** — a literal ending in `token`, `password`, `secret`,
  `api_key` or `url`. **Defaults to no**, value masked: it is the one kind where a false positive is
  likely, and patching a non-secret by default is a silent regression.

The vault is written before the Fastfile: if lifting fails, nothing has been patched to read a
missing variable. The patch is spliced by byte offset — everything outside the replaced range is
byte-identical — and the file is re-parsed before the command returns; if it no longer parses, the
previous content is restored.

```diff
-  upload_to_play_store(json_key: "./play-service-account.json", track: "beta")
+  upload_to_play_store(json_key: ENV.fetch("SUPPLY_JSON_KEY"), track: "beta")
```

`ENV.fetch` rather than `ENV[]`: a missing variable fails at the top of the lane and names itself,
instead of reaching an action as `nil`.

**Setup does not commit or push.** It prints the `git diff` command and stops — the working copy is
yours. So **a patched Fastfile changes nothing until you push it**: Laneyard builds from the remote,
and until the commit is there, every run still reads the old path. It also does not take the
credential out of your history; where `git ls-files` finds the file, it says so — rotating the key is
the fix.

Two things it leaves alone: a value written as a heredoc (its reported location is the marker, not
the text, so patching would corrupt the file), and the Android keystore (configured in Gradle, not
the Fastfile — handled under Signing credentials below).

Declining writes nothing, anywhere. And where nothing can run Prism — a Mac whose only Ruby is the
system 2.6 — setup prints `Fastfile not analysed …` and finishes as always. The scan is a service,
never a gate.

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
    - { name: lea, role: builder, password_hash: "scrypt$…", projects: [cartes-ios] }
  max_concurrent_runs: 1         # only 1 is accepted, see below
  retention: { runs: 50, artifact_days: 30 }

projects:
  - slug: cartes-ios
    name: Cartes iOS
    git_url: git@github.com:you/cartes.git
    default_branch: main
    git_auth: { kind: ssh_key, ref: ~/.ssh/id_ed25519 }
```

`max_concurrent_runs` accepts `1` only. Runs drain from a single queue, one at a time across every
project — parallel runs would need a working directory per run, which does not exist yet. A larger
number is refused at load, so a server is never configured for builds that never happen.

### Accounts

Everyone who signs in has a name, a password and one of two roles — two, because a third is easy to
add and impossible to remove.

| | **admin** | **builder** |
|---|---|---|
| start a build, watch it, cancel it | ✓ | ✓ |
| download artifacts, read logs and the Fastfile | ✓ | ✓ |
| see the readiness checklist | ✓ | ✓ |
| read and write secrets | ✓ | |
| save, commit and push the Fastfile | ✓ | |
| remove a project | ✓ | |
| manage accounts | ✓ | |

A builder is who you give someone who ships without being trusted with the signing chain: they press
the button and watch, and never see a credential.

The interface shows a builder only what a builder can use — no secrets, fastfile, settings or
accounts tabs. That is courtesy, not security: the server refuses those routes on its own, whatever
the browser was shown, and the test suite proves it for every verb and every spelling of the address.

#### Which projects a builder reaches

An admin reaches every project. A builder reaches only the projects it is granted, from the accounts
screen. A project a builder cannot reach is **invisible**, not shown-and-locked — absent from its
lists and a 404 by URL, answered with the body a nonexistent project gives, so the two cannot be told
apart. Enforced by the server, in one place, not the browser.

The reach is a `projects` list on the account in `config.yml`, with three states:

- **absent** — every project. A config written before this feature grants everyone, so nobody loses
  access on an upgrade.
- **`[]`** — no project. What a new account starts with, so a new builder sees nothing until granted.
- **a list of slugs** — exactly those projects.

Removing a project strips its slug from every account, so a grant never points at a project that is
gone, and a re-created slug does not inherit an old grant.

Add and remove accounts from the accounts screen, or from the command line:

```bash
echo "$PASSWORD" | laneyard user add lea --role builder
```

The password is read from standard input, never an argument — an argument lands in your shell
history. Without `--role`, the account is a builder.

Two things are refused, in the API and CLI alike: removing or demoting the last admin. A server
nobody can administer cannot be repaired from the interface.

Anyone changes their own password and name from **your account** — a builder included. Either asks
for the current password even though you are signed in: a session is a cookie in a browser that may
have been left open on a desk. Doing it ends every other session that account has. That is how the
password `laneyard setup` printed once stops being a string on a sticky note.

Changing your name edits your `config.yml` entry in place, keeping your role and access, and refuses
a name another account already has. The next time you sign in, you type the new one — self-service,
whatever your role.

Removing an account ends its sessions immediately — "remove the account" and "revoke access" are the
same act. So does editing `config.yml` by hand: every request looks the account up again, so a change
takes effect at once rather than at the next restart.

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

It looks **beside the Fastfile**, not at the repository root, because that is where an app keeps its
platform folders: `ios/` and `fastlane/` are siblings and move together when the app is one directory
of a monorepo. When that guess is wrong, `platforms` settles it.

Field by field, the repository file wins over the server block, which wins over the defaults. Any
field may also go in the server block, so a repository you would rather not touch can be configured
entirely from `config.yml`.

**A monorepo carries one `laneyard.yml` per app**, in the app's own directory beside its fastlane
folder, so two apps on one remote each describe their own build. Inside an app-level file **paths are
relative to that file's directory** — `artifact_globs: ["**/*.aab"]`, a plain `fastlane_dir:
fastlane` usually left out — so an app moved or duplicated keeps its file unchanged. A `laneyard.yml`
at the repository root still works, with repo-root-relative paths.

Both files are watched: edit them by hand and Laneyard picks the change up. An invalid file is
reported and the last valid configuration stays live — a typo never takes the server down.

### Secrets

The variables your lanes read go into an encrypted vault, from a project's Secrets tab — global
secrets apply everywhere, a project's own win over them. The files it signs with go in the same
vault as blocks (below).

A secret is write-only: the server never sends a masked value back, so no browser ever holds one.
What you did not mark secret — `APP_VERSION`, an issuer id — is shown on request, one key at a time;
masking and unmasking switch which it is without retyping the value.

Nothing in your lanes has to change afterwards: `key_filepath:` and `json_key:` keep working — a
signing block puts a real file back on disk for the length of a run. A secret becomes an environment
variable for every run of its project, kept out of the logs; a masked value must be at least four
characters (see below).

### Signing credentials

A signing credential is not a string: an Android keystore is bytes Gradle reads through a path, and a
`.p8` is useless without its key id and issuer id. So these are stored as blocks — one file plus the
fields that make it usable, taken whole or refused. A keystore stored without its alias is not a
partial success; it is a build that fails in a month.

| block | the file | the fields beside it |
| ------------------------------ | ---------------------- | ------------------------------------------- |
| *app store connect key*        | `.p8`                  | key id, issuer id                           |
| *android upload keystore*      | `.jks` or `.keystore`  | key alias, store password, key password     |
| *play store service account*   | JSON                   | —                                           |

They live in the **signing** part of a project's Secrets tab. The file is encrypted at rest and never
comes back out to a browser: a stored block shows its file name and nothing more, so replacing one
means giving it again in full.

A variable a block has made redundant is said to be so, beside the row and in one sentence:
`SUPPLY_JSON_KEY_DATA` once a Play block applies — it still works, but the same credential is then
stored twice — and `APP_STORE_CONNECT_API_KEY_P8`, which no action in fastlane has ever read.
Neither is removed for you: the row is yours, and the button to drop it is on the same line.

**A block becomes real files, for the length of a run.** Gradle's `storeFile` and
`app_store_connect_api_key` both want a path, so a credential that exists only as ciphertext cannot
be used. Each block that applies is written into `~/.laneyard/runs/<run id>/secrets/`, mode `600` in
a `700` directory, removed when the run ends — passed, failed, cancelled or timed out. Every
applicable block is written whether or not the lane looks like it needs one: a Fastfile can reach
anything through `sh` or a plugin, and a wrong guess of "not needed" is a debug-signed artifact, not
a missing variable.

**It reaches your lanes under the names your project already reads.** Each form is pre-filled with
the names fastlane declares — `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH`/`_KEY_ID`/`_ISSUER_ID`,
`SUPPLY_JSON_KEY` — and every one is editable. A Fastfile written around
`ENV.fetch("ASC_KEY_FILEPATH")` is not doing it wrong: you say so on the form instead of renaming
anything. The name stored is the only one exported — no default is emitted alongside, which would
make a typo look like it worked. The keystore's names are Laneyard's own (`ANDROID_KEYSTORE_PATH`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`), same rule.

**The keystore block can also supply `key.properties`.** Flutter's own build script signs with the
release config when that file exists and the debug config when it does not, and gitignores it — so on
a build server it is always absent. Rather than telling you to rewrite the script, Laneyard writes
the file it looks for, for the length of the run, out of the keystore block. Two things it cannot
read from the script are asked for on the block: where the file goes, and what the keys inside are
called (starting from Flutter's four).

**Only the projects that sign need any of this.** fastlane also takes screenshots, runs tests, syncs
certificates — so the three blocks are an offer, not a gate. A project that just wants an artifact
out of Gradle needs the keystore and nothing else.

A block stored on a project belongs to that project. One stored globally applies to every project,
and a project's own block wins over it. Both are admin-only, like the rest of the vault.

### Readiness

Every project has a Readiness tab: what stands between it and a build that runs while nobody watches.
Only the checks that apply are shown — an Android project is never asked for an App Store Connect key.

**What a tick means.** The checks read your Fastfile, following a lane into the methods it defines.
Two things stay out of reach: `import`/`import_from_git` pulls in lanes from elsewhere, and
`fastlane/actions/` holds actions whose names mean nothing to a reader that has only seen the
Fastfile. Where either applies, a check that found nothing says *could not tell* rather than ticking.
A green tick means "looked, and it is fine" — never "looked, and saw nothing".

Always:

- **the repository** answers `git ls-remote` without asking for credentials — a run that meets a
  password prompt does not fail, it waits;
- **dependencies** are installable: `bundle check` against your Gemfile, or the `fastlane` a run
  would otherwise find on the PATH;
- **no lane calls an action known to stop and ask** — `prompt`, `sigh`, `cert`, a writable
  `match`, an upload waiting for its summary to be confirmed;
- **the variables the lanes read** are in the vault. Every `ENV.fetch("…")` a lane reaches is
  collected and looked up — the commonest way a project that works on your laptop fails on a server:
  the variables live in a gitignored `fastlane/.env` that never reaches the clone.

  Two things a Fastfile cannot tell you. A variable read by a tool the lane shells out to —
  `sentry-cli` and `SENTRY_AUTH_TOKEN` — is named nowhere in the lanes; a committed
  `fastlane/.env.example` is read for exactly this, and `required_secrets` in `laneyard.yml` covers
  the rest. A variable found only in the server's own environment is reported, not ticked: it works,
  but because of how the server was started.

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
- **the release is signed with the release key.** The one check whose failure is silent: Flutter's
  own snippet signs with the release config when `key.properties` exists and the *debug* config when
  it does not, and gitignores that file — so it is absent from every clone. The build then succeeds
  with a debug-signed artifact, and the store rejects it minutes later saying nothing about signing.
  This reads the Gradle file as text and says so before the build; and for a project whose keystore
  is stored here, writes the `key.properties` the build asks for, for the length of the run — marked
  `# written by laneyard, do not commit`, removed when fastlane stops. A file of your own without
  that marker is never touched;
- **the Play Store service account** is there when a lane calls `upload_to_play_store`. The vault
  first — a block, or a `SUPPLY_JSON_KEY` variable stored before blocks existed — then the
  `json_key` argument in the call, then the **Appfile**: `json_key_file` and `json_key_data`, which
  is where a long-standing project almost always keeps it. Only the vault is a tick; the other two
  are *could not tell*, for the same reason as above.

Like the iOS ones, the Android checks read **literal arguments only**. `gradle(storePassword:
ENV["PW"])` is reported as undetermined, never guessed at: a checklist that guesses gets believed.

They run when you open the tab or press refresh, never on their own — they shell out to git and
bundler. The last run's time is on screen, because a stale green tick is worse than a red cross.

Nothing here blocks anything. A red check is never why a run cannot start, and Laneyard never edits a
Fastfile to make its own checklist green — each line explains, you decide. Where the fix is one
action, the line links to the Secrets tab.

**What it cannot see.** The checklist reads *literal* arguments only. `match(readonly: true)` is
green, `match(readonly: false)` a warning, but `match(readonly: ENV["RO"])` has no value until the
lane runs — reported as undetermined (`○`, with the reason) rather than guessed. A checklist that
guesses gets believed, and then it is worse than none. Android signing is read from the Gradle
script, as text — running someone's build script to ask it a question is not something it may do.

### The Fastfile

Every project has a Fastfile tab. **It is a text editor** — your file, in a box, with Ruby syntax
highlighting and nothing between you and it. The structured view, where lanes and actions are things
you arrange rather than type, is still to come; this first half is useful on its own: fixing a lane
at 2am should not require an SSH session.

**Every write is verified.** Saving sends the file to the server, which writes it byte-for-byte then
asks fastlane to parse it and list its lanes. If that fails, the previous content is restored before
the request answers, and fastlane's reason appears above the editor with your work still in the box.
A broken Fastfile never reaches a workspace a run might build from.

Saving is explicit: verification is a Ruby subprocess, not a regex, and running it on every keystroke
would be slow and dangerous. `⌘S` is another way to ask, not an autosave. Laneyard also refuses to
write while a run of that project is in flight — that run is reading the very file the write replaces.

Below the editor is what git makes of the workspace: the diff, a message field, `commit` and `push`.
A commit stages exactly the files that changed, never `git add -A` — a build scatters artifacts and
reports around, and none belong in your history.

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
  The screen counts them before and after, because they are the one thing here you cannot go and look
  at: no route ever sends a credential back.

What it does *not* touch:

- **the git remote.** The repository is on your host and disk; Laneyard neither reads nor writes it;
- **the credential originals.** The `.p8` and keystore you uploaded are wherever you keep them;
  Laneyard removes only its own encrypted copy;
- **global secrets and global signing blocks.** Read by every project, not this one's to take. The
  result names how many it left.

Removal is refused while a run of that project is in flight — that run is using the workspace. A
queued run will not start: it ends as failed, saying its project is gone.

The same thing from the command line, run from the app's directory — the one holding its
`laneyard.yml`:

```bash
cd apps/cartes-ios
laneyard remove --dry-run   # show what would go, and stop
laneyard remove             # remove it, after a typed confirmation
```

No slug to give: it reads one from the `laneyard.yml` there, refusing if the file is missing or has
no slug (run `laneyard setup` again). It deletes that file too, and says to commit the deletion.
Otherwise it matches the Settings tab: confirmed by typing the slug back, `--dry-run` stops at the
inventory, refused during a run.

### Resetting

```bash
laneyard reset --dry-run   # show what would go, and stop
laneyard reset             # wipe it, after a typed confirmation
```

`laneyard reset` wipes the data and keeps you able to use Laneyard: every project, the database, the
workspaces, the artifacts and the logs go; your accounts and the vault key stay. You sign in with the
same names afterwards, and keeping the key means an older `laneyard.db` backup stays readable. The
database comes back empty on the next start, which also clears sessions, so everyone signs in again.

It keeps the `server:` block of `config.yml` (accounts, port, bind, retention) and `~/.laneyard/key`,
and never touches the git remotes or credential originals. It reads the inventory first and, like
`uninstall`, is confirmed by typing the folder's path, not `y`.

### Uninstalling

```bash
laneyard uninstall --dry-run   # list what is there, and stop
laneyard uninstall             # remove it, after a typed confirmation
npm uninstall -g laneyard      # remove the package itself
```

`laneyard uninstall` removes the data folder: `config.yml`, the vault key, the database, the
workspaces, the artifacts and the logs. It reads the whole inventory from disk first — projects,
secret and block counts, sizes and paths — and prints it before asking.

The vault key is the one loss that cannot be undone: every secret and block is encrypted under
`~/.laneyard/key`, and once it is gone the database is ciphertext nobody can read. The originals are
yours and untouched — the `.p8` in your downloads, the keystore in your safe — so what you agree to
is uploading them again. Global secrets and blocks go too; the inventory says so.

Confirmed by typing the folder's path, not `y`: this is the one command that destroys credentials.
Anything in the folder Laneyard did not put there is named, left alone, and the folder kept for it.
It does not remove the npm package — a command cannot delete the binary it runs from — and prints the
command that does, on purpose: a package manager must not delete someone's signing keys on its own.

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
- **Secrets are encrypted at rest.** Values are stored with AES-256-GCM under a key in
  `~/.laneyard/key` — outside the database, mode `600`, and Laneyard refuses to start if anyone else
  can read it. Someone who walks off with `laneyard.db` gets ciphertext. Nothing else holds
  plaintext: the store, API and interface deal in names only, and no route sends a value back — which
  is why the Secrets tab has no reveal button.
- **A signing block is on disk only while a run needs it.** The file is written into
  `~/.laneyard/runs/<run id>/secrets/`, mode `600` in a `700` directory, and that directory goes when
  the run ends. The block's secret fields — the keystore passphrases — are stripped from output like
  any masked secret, because gradle will echo one back on failure.
- **Masked values are removed from output before it is written, not when displayed.** The
  substitution happens once, where a run's output fans out, so the log file, the live stream and the
  stored error summary all hold `••••••`. It survives being split across two chunks of output.
- **Do not put secrets in `config.yml`.** It is a plain file with ordinary permissions. Use the
  Secrets tab, which puts them in the encrypted vault instead.

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
  credential Laneyard puts in the clone rather than the run's own directory, because Gradle resolves
  that path relative to the build. Mode `600`, a marker as its first line, removed when the run ends
  and swept for at the start of the next in case a server was killed mid-build. A file of yours
  without that marker is never touched.

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
- `✓` setup names the credentials a Fastfile hardcodes, and offers — refusably — to lift them into
  the vault and patch the file
- `○` git-triggered and scheduled builds

Two things worth knowing: listing lanes does not fetch the repository, so a lane you just pushed
appears after the next run; and runs execute one at a time across all projects. A queued run survives
a server restart and starts on its own.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `npm test` runs the whole suite in
seconds against a fake fastlane, so you can work on any machine, with no Xcode, no signing
certificates and no network.

## Licence

MIT — see [LICENSE](LICENSE).

Built on [fastlane](https://fastlane.tools), and not affiliated with it.

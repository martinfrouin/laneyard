# Changelog

## 0.11.0

### Runs identified by what they built

A run used to be listed by its own id — a row number in the server's database, which nobody looking
for a build has anything to compare against. Each run now shows the build number it was handed and
the app's version: `#87 1.4.2`.

The version is read off the working tree once the lane has finished — `pubspec.yaml`, `versionName`,
`MARKETING_VERSION` — so a lane that bumps it reports what shipped. A project that keeps its version
somewhere else shows the build number alone; nothing is guessed, and runs from before this release
show none.

### `LANEYARD_BUILD_NUMBER` is no longer asked for as a secret

The documentation tells you to write `ENV.fetch("LANEYARD_BUILD_NUMBER")`, and every Fastfile that
did was then reported as needing a variable the vault refuses to hold — a row on the secrets tab
with a field nobody could fill, and a checklist warning with no way to go green. Laneyard sets it,
so nothing asks you for it.

### The address that opens your project

Started from a project's folder, `laneyard` now prints the address of that project rather than of
the list. Running it from `popotheque/app` and clicking the link lands where you meant.

## 0.10.0

### A build number, without a counter in your repository

Every store wants a number that only goes up, and until now nothing handed one to a lane. So each
project invented the same counter: a file in the repository, read, incremented, written back,
committed and pushed by the lane itself — a build writing to its own git remote to remember how many
times it had run.

Every run now carries `LANEYARD_BUILD_NUMBER`, counting up per project. There is nothing to turn on
and nothing to add to `laneyard.yml`:

```ruby
build = ENV.fetch("LANEYARD_BUILD_NUMBER")
sh "flutter build ipa --release --build-number=#{build}"
```

The name is fixed and a stored secret cannot shadow it — a build that could rewrite the counter it
was handed would not be a counter. The number is taken when a run starts and kept whatever happens
to it: skipping one costs nothing, while reusing one after a run that failed between two store
uploads is a release the store refuses. A run cancelled while still queued takes none.

The lanes tab shows what the next run will get, and an admin can set it: a project arriving with a
counter its repository already kept starts where that one stopped. The run screen shows the number
each run was handed, so an artifact downloaded weeks later says which build it is.

Nothing is written back to your repository — no commit, no tag, no counter file. A lane that wants a
tag still makes it, with the number it was given.

## 0.9.0

### A signing block you can read, and correct a piece at a time

A stored block showed the word `stored` for every field it held. That is the same word for a right
key alias and one missing a character — and a store password one character short is `keystore
password was incorrect`, after a Gradle run, from a screen that was claiming everything was in place.

A block now shows what you typed. The fields that are not secret come with the listing; a password
comes on `show`, one field per request, the way a masked secret already did. `hide` puts any of them
back.

And each part changes on its own. `edit` a field or an exported variable name; `replace` swaps the
file and keeps the fields beside it — a `.p8` is rotated far more often than the key id and issuer id
next to it, and re-supplying those to upload a new file was one more chance to get right what was
already right. A block arriving for the first time is still taken whole or refused: a keystore with
no alias is not a partial success. A required field can be corrected, never emptied.

The keystore's two settings — where the properties file goes, and the keys inside it — now carry
their label beside the box instead of inside it, where it read `Properties file, rel…` and answered
nothing.

### A properties path that is not where your build reads

That field wins outright at run time: it exists because detection cannot always tell, and a setting
someone corrected must not be second-guessed by the guess it corrected. The cost was a path one
directory off — written, read by nobody, and the release build falls back to the debug config. It
does not fail. The store rejects the artifact, hours later, saying nothing about a path.

The field now arrives pre-filled with the place this project's build actually reads, resolved from
the clone, so a wrong value is visible as a value that differs. Where a stored one disagrees, the
block says so on the signing screen and the readiness checklist turns amber, naming both paths.

Still a warning and not a refusal: the parser can be wrong about the directory too, and a correct
path overruled by a bad reading would be a build that cannot run at all. Leave the field empty and
Laneyard writes the file where the build reads it.

## 0.8.0

### The file your build reads, in the clone for the length of a run

A project's own `.env` — the one its app reads, not the one fastlane reads — is gitignored, so it
never reaches a clone. The vault did not answer that: a stored secret becomes an environment
variable, which is enough for fastlane and no use at all to anything that reads a *file*.
`flutter_dotenv` bundles `.env` as an asset, `--dart-define-from-file` reads a path at compile time,
an `.xcconfig` is a file by definition. None of them looks at the environment, and none of them fails
loudly — they produce an app configured with nothing.

Tick **write one** in the Secrets tab, give it a path, and tick the variables that belong in it. The
tick is on each variable, made where you create it rather than in a picker you visit later. Under the
block, the file itself — rendered as the run will render it, masked values as dots — so a line you
forgot to tick is visible rather than discovered from a shipped app.

`env_file: .env` in the repository's `laneyard.yml` does the same and wins, as it does for every
setting.

Written when the run starts, removed when it ends however it ended, marked
`# written by laneyard, do not commit`. **A file already there without that marker is never written
over and never removed.** Ticking decides membership of the file and nothing else: the variable still
reaches the run through the environment like every other one.

Left off, nothing is written and nothing changes.

### A secret belongs to one project

The vault had two scopes. A secret or a signing block stored under no project applied to every one of
them, and a project's own quietly won over it. It bought sharing — an App Store Connect key is one
per developer account, not one per app — and it cost the answer to the question the screen exists to
answer: *what does this project see?* That answer was a merge of two sets no screen ever showed
whole, and a name stored twice resolved to the nearer one without saying so.

Everything now belongs to exactly one project, signing blocks included. Five apps under one account
hold five copies of the key, and rotating it means replacing five. That is the price, and it is
paid for a rule with no exception to state.

**Nothing that built yesterday stops building.** On first start, every row that was shared is
**copied** into each project that read it, and the server prints what it did — one line per key, and
the projects it went to. A project that had overridden a shared value keeps its own. Delete the
copies you did not want; the report is there so you know they exist. A row no project ever read is
removed, and said so rather than dropped in silence.

The unscoped API routes are gone, the interface has no `global` badge left, and removing a project no
longer reports what it was not allowed to take — there is nothing it is not allowed to take.

## 0.7.0

### fastlane starts from the app's directory, not the repository root

A project whose Fastfile sits in `app/fastlane` could not build. fastlane looks for `fastlane/` in
the directory it was started from and nowhere else, found nothing, offered to set the project up,
and — with nobody to answer — printed a Ruby backtrace over the sentence that mattered. A clone with
no fastlane folder now fails with that sentence instead of reaching fastlane at all.

### Refresh, beside the names a lane is missing

The screens read the clone, and only a run ever fetched it. A project whose first run failed early
kept answering from that commit. Refresh brings the clone up to the remote without building
anything. Refused while a run is in flight, or when the workspace holds a commit that was never
pushed.

### Run again, from the run screen

The run screen carries the project's tabs now, and a button that starts the same lane with the same
parameters. It was a dead end: no way back but a link that looked like a label, and no way to retry.

### Stored values on screen

A variable stored in the clear is printed in every log its lane produces, so it is shown here too. A
secret is never in a listing, and `show` fetches it by name when you want to check one. Nothing is
masked while you type it.

### Less text

Every tab opened with a paragraph explaining what it was. They are gone, along with the sentence
under half the rows and most of the readiness prose. What is left on a screen is what is true of
this moment.

## 0.6.4

### `laneyard remove <slug>`, for a project with no file to read

Reading the slug from `./laneyard.yml` left no way to remove a project whose file
was never written, lost its slug, or whose repository is not on this machine any
more — only the web could. A slug given outright overrides the file. One naming a
different project is left where it is.

### Setup adds a missing slug, so a project stays removable

A `laneyard.yml` written before slugs existed has none, and `laneyard remove`
refuses a slug-less file — telling you to run `laneyard setup` again, which left
the file untouched. The project could not be removed from the command line at
all. Setup now adds the `slug:` when it is missing, through the YAML document, so
the comments, the key order and every value the file carried survive. An existing
slug is never touched.

### Setup's last question says what it will write

`Set up "popotheque"?` arrived at the end of a run of unrelated questions, with
the two files it writes explained far enough up the screen to have scrolled off —
so the one question that actually commits to something was the one with the least
on screen. It now names both files right above itself, and says which one you
commit and which one is already there and will be left alone.

## 0.6.3

### Adoption names every argument it rewrites

A proposal that renames an App Store Connect key file also renames the Key ID and
the Issuer ID beside it — but the prompt was built from the one argument it was
anchored on, so it said `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH` and rewrote
three things. It now lists each argument, what it says today and the name it will
read, and asks about all of them.

## 0.6.2

### Setup asks for the fastlane folder as you write it from where you are

Run from `app/`, setup proposed `app/fastlane` — the repository-root-relative
form, which is what the clone has and what `config.yml` stores, but not what you
would type standing inside `app/`. It asks for `fastlane` now and does the
prefixing itself; from the repository root, where fastlane usually sits, nothing
changes.

Correcting that answer also works properly: the app root was read from the
*detected* folder before the question was asked, so a correction left
`laneyard.yml` beside the wrong app with the wrong prefix dropped from its paths.
It is computed from the answer now.

## 0.6.1

### Setup normalises credential args that already read a variable

Adoption only ever rewrote literal values, so a Fastfile that already read its
App Store Connect and Play credentials from variables of its own —
`issuer_id: ENV["ASC_ISSUER_ID"]` — was left as it was, and you had to store
those `ASC_*` names as secrets by hand. Setup now rewrites the credential args of
`app_store_connect_api_key` and `supply`/`upload_to_play_store` to the names a
signing block exports (`APP_STORE_CONNECT_API_KEY_*`, `SUPPLY_JSON_KEY`) whether
they are literals or `ENV[...]` — so you store the `.p8`/JSON once as a block and
delete the `ASC_*` secrets. A value already reading the right name is left alone.

Also: `laneyard --version` read a hand-bumped constant that had drifted to 0.5.0;
it reads `package.json` now, so it cannot lie again.

## 0.6.0

What `laneyard setup` does about a credential the Fastfile names outright, and a
`laneyard.yml` that each project command reads from where it lives.

### `laneyard remove` runs from the project's directory

`laneyard.yml` now carries a `slug`, written by `setup`. `laneyard remove` drops
its slug argument and reads it from the `laneyard.yml` in the current directory —
refusing if the file is absent, or has no slug (run `setup` again). It deletes
that file too; commit the deletion.

### `laneyard secret` is gone

Secrets are managed from the web. The CLI `laneyard secret set`/`import` is
removed; the vault and what the server and interface do with secrets are
untouched.

### Setup offers to lift a credential your Fastfile hardcodes

A Fastfile naming its credential by a literal path — `json_key:
"./play-service-account.json"` — builds on the laptop it was written on and
cannot build anywhere else. Laneyard builds from a clone of your remote, so
either that file is gitignored and absent from the clone, or it is committed and
a signing key is in your repository's history. Setup used to finish green on such
a project and say nothing about it, and there was nothing it could have said:
everything Laneyard has for credentials hangs off a variable name, and a Fastfile
that reads no variable offers nothing to attach a block to.

Setup now reads the Fastfile with Prism once it has finished — after `Project "x"
is set up` has printed, which is the guarantee rather than a presentation choice
— and offers, one credential at a time, to lift it into this machine's vault and
replace the literal with `ENV.fetch(…)`. A path resolving to a file that is
really on disk, and a key written into the file inline, are offered with the
question defaulting to yes. An argument that merely looks like a secret —
`token`, `password`, `api_key` — defaults to no and has its value masked on
screen: it is the one case where a false positive is likely, and a patch applied
by default to something that was never a secret is a silent regression in
someone's build.

It does not commit and does not push. It prints the `git diff` command and stops,
so a patched Fastfile changes nothing until you push it — which the closing
message says in those words, because Laneyard builds from the remote and that is
the trap. It does not take the credential out of the repository either: where
`git ls-files` finds the file, it says the key is in your history and that
rotating it is the fix, and touches nothing.

Declining every proposal writes nothing anywhere and leaves the project
registered exactly as it was, which is the line the whole feature is bounded by.
Laneyard may notice something about a repository and offer a correction; it may
not make a working project depend on the correction being taken.

On a machine with no Ruby that can load Prism — macOS's own 2.6 cannot — setup
prints one line saying the Fastfile was not analysed, and finishes as it always
did. The scan is a service, never a gate.

When the key file of an `app_store_connect_api_key` is lifted this way, a
`key_id:` or `issuer_id:` written as a literal in the same call is lifted with
it — rewritten to the variable the signing block exports and used to pre-fill
that block's fields. Only then: an identifier means nothing without the key it
names, and only that key's own block exports it, so one written where no key file
is adopted is left exactly as it was rather than pointed at a variable nothing
supplies.

## 0.5.0

Who reaches which project, what a removal actually removes, and a `laneyard.yml`
that a monorepo can carry one of per app.

### Removing a project removes what Laneyard holds for it

0.4.1 made a removed project *say* what it left behind — the clone, the
artifacts, the runs, the secrets and blocks under its slug — and left them there,
on the argument that destroying a keystore from a web click was worse than a
redundant row. That argument lost. Leaving a project's data on the machine after
the project is gone turned out to be the surprising behaviour, not the safe one,
and the re-attachment hazard — a project set up later under the same slug finding
an old keystore and signing with it — was too sharp to keep as a footnote.

Removal now removes everything Laneyard holds for that one project: its block in
`config.yml`, its clone, its artifacts, its run history and logs, and the secrets
and signing blocks scoped to its slug. It is confirmed by typing the slug back,
because it now cannot be undone. What it still does not touch, and says so: the
git remote — the repository is on your host, not Laneyard's — the credential
originals, of which Laneyard only ever held an encrypted copy, and the global
secrets shared by every project. The separate "remove the vault too" step from
0.4.1 is gone; there is one act now, and it is complete.

### `laneyard remove` and `laneyard reset`

The same removal, from the command line. `laneyard remove <slug>` does to one
project exactly what the removal screen does, confirmed by typing the slug and
with a `--dry-run` that writes nothing. `laneyard reset` clears the data — every
project, the database, the workspaces, the artifacts, the logs — and keeps your
accounts and the vault key, so it is a fresh start rather than a way to lock
yourself out. The key is kept on purpose: without it, older database backups
would be unreadable. Both share their removal core with the web route and with
`uninstall`, so the four say and do the same thing.

### Builders can be given only some projects

Until now a builder saw every project on the machine. An admin can now grant a
builder specific projects, from the accounts screen. A project a builder was not
given is invisible — absent from their list, and answered as unknown by its URL,
the same as a project that does not exist — because the check is in the one place
that already decides what a request may do, not in the interface.

It is off by nobody's expense: an account that carries no grant list at all
reaches everything, so no existing installation loses access on upgrade. A newly
created account starts with none and is given projects one at a time. An admin
always reaches everything; there is still no third role, only a reach check on
the builder one.

### Change your own identifier

Beside changing your own password, you can now change your own login name, from
the same account page and under the same rule — it asks for your current
password, because a session is a cookie that may have been left open. The rename
edits your account in place, so your role and, if you have them, your project
grants survive it, and it re-issues your session under the new name so you stay
signed in on the page you did it on.

### `laneyard.yml` can live in an app's own directory

A monorepo holding two apps could not have two `laneyard.yml` files: the file was
read only from the repository root, so there was one per repository and nowhere
to put a second. It can now live in an app's own directory — `app/laneyard.yml` —
and a repository of N apps carries N of them. Inside an app-level file, paths are
relative to that file: `artifact_globs: ['**/*.aab']`, `fastlane_dir` left at its
default, without repeating the `app/` prefix on every line. A file at the
repository root keeps working exactly as before.

### A missing fastlane directory explains itself

Point Laneyard at a fastlane folder that is in your working copy but not in git —
because it is uncommitted, or gitignored, or a local copy — and the build used to
fail with a bare `ENOENT` naming a path in a clone, with no hint why the path was
not there. Laneyard builds from a clone of the remote, so a folder only on your
disk never reaches it. `laneyard setup` now warns when the fastlane directory it
detected is not tracked by git, and a build that cannot find it says that in a
sentence instead of an errno.

### The 0.2 single-password config form is gone

An installation from 0.2 stored one account as `server.password_hash` and logged
in with a password and no name. Every release since has stored a `users` list,
and that back-compatibility has now been removed: a `config.yml` carrying only
`server.password_hash` is refused at load, and a login must carry a name. If you
are still on the 0.2 form, move it to a `users:` list before upgrading.

## 0.4.1

Three things a 0.4.0 installation had no way to find out: what removing a project leaves behind,
how to remove Laneyard itself, and where your own password is changed.

### Removing a project says what stays in the vault

A removed project left its secrets and its signing blocks behind, encrypted in the database under
its slug, and nothing said so. Nothing could have: a credential is the one thing in Laneyard that
never comes back out — no route sends one to a browser — so there was no screen on which those rows
would ever have appeared again.

That silence had a sharper edge than wasted bytes. The scope of a stored credential is the slug, so
a project set up later under the same name would find the old keystore still there and sign with a
credential nobody had uploaded.

The removal screen now counts them, the way it already names the clone and the artifacts it is
about to delete, and counts the rows that belong to no project separately: those are shared by every
project and are not one project's to lose. Removing them is a second, deliberate act — refused while
the slug is still a project, and confirmed by typing the name again. Deliberately not a checkbox on
the first confirmation: removing a project destroys nothing in the vault on purpose, and the `.p8`
in there is often the only copy anyone has.

### `laneyard uninstall`

`npm uninstall -g laneyard` left the data folder untouched — the configuration, the vault key, the
database, the workspaces, the artifacts, the logs — and no command removed them. There is still no
npm lifecycle hook doing it, and there should not be: a package manager must not delete someone's
signing keys on its own, and a lifecycle script has no way to ask.

So this asks. It reads the whole inventory from disk before touching anything — the projects, how
many secrets and how many signing blocks, project scope and global scope apart, the real sizes and
paths — and prints it. Then the one loss that has no undo, said on its own: the vault key exists in
exactly one place, and without it `laneyard.db` is ciphertext, so a backup of the database alone
restores nothing.

It is confirmed by typing the folder's path back, not by a `y`. There is no `--yes`, no `--force`
and no `--keep-runs`: each of those is a way to run this command without reading it, and reading it
is the point. `--dry-run` prints the inventory and stops, writing nothing at all — the database is
opened read-only, and the `-wal` and `-shm` files SQLite creates in order to read are removed again
if they were not there to begin with.

It leaves anything in the folder that Laneyard did not write, names it, and keeps the folder for it.
It does not remove the npm package either — a process cannot sensibly delete the binary it is
running from — so it prints the command that does.

### Changing your own password was there, and was not found

The form has been on `/account` since 0.4.0, and the only way in was your own name in the header,
labelled with a hover title. The reasoning was that whoever wants to change their password looks for
themselves on screen first. Someone did, and did not find it: a name is a fact about the page, not a
control, and a label nobody hovers is a label nobody reads.

The words are on screen now. `your account` sits in the header beside `sign out`, and on the accounts
screen your own row — the one row that cannot carry the ✗ the others do, and which used to dead-end
in a dash — leads to the same page. An admin has a particular reason to look there: there *is* a
screen that manages people, and their own account was the one it said nothing useful about.

Changing a password still does not happen in the accounts table. That page is the server's list of
people; this is one person, and it is the one thing on it nobody else can do for you. Only the way
in changed.

### `laneyard --version` said 0.3.0

The number is written in the source and had not been moved since. Every published copy of 0.4.0
reported itself as 0.3.0, on `--version` and in the line the server prints when it starts.

## 0.4.0 — 2026-07-22

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

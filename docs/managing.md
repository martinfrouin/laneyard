# Managing a project

## The build number

Every run is handed `LANEYARD_BUILD_NUMBER`, a whole number that counts up per project. Nothing to
configure — read it where your lane needs one:

```ruby
build = ENV.fetch("LANEYARD_BUILD_NUMBER")
sh "flutter build ipa --release --build-number=#{build}"
```

It is set by the server, so a lane run by hand outside Laneyard does not have it. Decide what that
means for your project — a default, or a refusal:

```ruby
build = ENV.fetch("LANEYARD_BUILD_NUMBER") { UI.user_error!("run it from Laneyard, or pass build_number:") }
```

The number is taken when a run starts and kept whatever happens to it: a failed build consumes one.
Skipping a number costs nothing, whereas reusing one after a run that failed between two store
uploads is a release the store refuses. A run cancelled while still queued takes none.

The lanes tab shows what the next run will get, and an admin can set it — starting where a counter
your repository already kept stopped, or correcting after an upload made by hand. It is refused
while a run is in flight, since that run already holds its number.

Nothing is written back to your repository: no commit, no tag, no counter file. A lane that wants a
tag still makes it, with the number it was handed.

## The Fastfile

Every project has a Fastfile tab: a text editor with Ruby syntax highlighting, and nothing between
you and your file. Fixing a lane at 2am should not require an SSH session.

**Every write is verified.** Saving writes the file byte-for-byte, then asks fastlane to parse it and
list its lanes. If that fails the previous content is restored before the request answers, and
fastlane's reason appears above the editor with your work still in the box — a broken Fastfile never
reaches a workspace a run might build from.

Saving is explicit (`⌘S` is another way to ask, not an autosave), and refused while a run of that
project is in flight, since that run is reading the file the write would replace.

Below the editor is git: the diff, a message field, `commit` and `push`. A commit stages exactly the
files that changed, never `git add -A`.

## Removing a project

The Settings tab removes everything Laneyard holds for the project, confirmed by typing its name.

**Removed:** its block in `config.yml` (through the YAML document, so your comments survive), its run
history and logs, the clone and artifacts on disk, and its own secrets and signing blocks in the
vault. The run history is the one thing nothing can rebuild — hence the typed confirmation.

**Not touched:** the git remote, and the credential originals you uploaded.

Removal is refused while a run of that project is in flight. A queued run ends as failed, saying its
project is gone.

The same thing from the command line, run from the directory holding its `laneyard.yml` — the
repository root for most projects, the app's own folder in a monorepo:

```bash
cd ~/code/cartes            # where laneyard.yml is
laneyard remove --dry-run   # show what would go, and stop
laneyard remove             # remove it, after a typed confirmation
```

No slug to give: it reads one from the `laneyard.yml` there. It deletes that file too, and says to
commit the deletion.

Where there is no such file — never written, or a repository no longer on this machine — name the
project instead: `laneyard remove cartes-ios`. A `laneyard.yml` naming a *different* project is then
left alone.

## Resetting

```bash
laneyard reset --dry-run   # show what would go, and stop
laneyard reset             # wipe it, after a typed confirmation
```

Wipes every project, the database, the workspaces, the artifacts and the logs. Your accounts, the
`server:` block of `config.yml` and the vault key stay — so you sign in with the same names, and an
older `laneyard.db` backup stays readable. Sessions are cleared; everyone signs in again.

## Uninstalling

```bash
laneyard uninstall --dry-run   # list what is there, and stop
laneyard uninstall             # remove it, after a typed confirmation
npm uninstall -g laneyard      # remove the package itself
```

Removes the whole data folder: `config.yml`, the vault key, the database, the workspaces, the
artifacts and the logs. The inventory is read from disk and printed before anything is asked.

**The vault key is the one loss that cannot be undone.** Every secret and block is encrypted under
`~/.laneyard/key`; once it is gone the database is ciphertext nobody can read. The originals are
yours and untouched, so what you agree to is uploading them again.

Confirmed by typing the folder's path, not `y` — this is the one command that destroys credentials.
Anything in the folder Laneyard did not put there is named and left alone. It does not remove the npm
package (a command cannot delete the binary it runs from) and prints the command that does.

# Managing a project

## The Fastfile

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

## Removing a project

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

The same thing from the command line, run from the directory holding its `laneyard.yml` — the
repository root for most projects, the app's own folder in a monorepo:

```bash
cd ~/code/cartes            # where laneyard.yml is
laneyard remove --dry-run   # show what would go, and stop
laneyard remove             # remove it, after a typed confirmation
```

No slug to give: it reads one from the `laneyard.yml` there, refusing if the file is missing or has
no slug (run `laneyard setup` again). It deletes that file too, and says to commit the deletion.
Otherwise it matches the Settings tab: confirmed by typing the slug back, `--dry-run` stops at the
inventory, refused during a run.

## Resetting

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

## Uninstalling

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


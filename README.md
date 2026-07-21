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
laneyard add     # adopt this project
laneyard         # start the server
```

`laneyard add` inspects what is there — the `fastlane` directory even when nested in a monorepo, a
`Gemfile`, an Xcode project or a Gradle build — writes the matching block into
`~/.laneyard/config.yml`, and prints a generated server password once. Write it down; it is not
shown again.

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
  password_hash: "scrypt$…"      # written by `laneyard add`
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

### `laneyard.yml` — optional, committed in your repository

Build behaviour belongs next to the code, so it can be versioned with it:

```yaml
fastlane_dir: fastlane
runtime: bundle                  # or `system`
timeout_minutes: 60
artifact_globs:
  - "build/**/*.ipa"
  - "build/**/*.app.dSYM.zip"
```

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

A secret becomes an environment variable for every run of the project it belongs to. Without
`--project` it applies to every project; a project secret of the same name wins over a global
one. Secrets are kept out of the logs unless you pass `--no-mask`, and a masked value must be at
least four characters long — see below.

## Security

Read this before putting Laneyard on a network.

- **It is built for a local network, not the internet.** It listens on `0.0.0.0` so you can reach
  it from your laptop, behind one password. Do not expose it publicly. If you need remote access,
  put it behind a VPN or an SSH tunnel.
- **The password** is stored as an scrypt hash and repeated failures are throttled. Sessions live
  in memory and do not survive a restart.
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
- `○` a checklist that gets a project running unattended
- `○` Fastfile editor in the browser
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

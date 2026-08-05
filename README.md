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

Setup has a second act: it names any credential your Fastfile hardcodes — a path only your laptop
has, a key written inline — and offers, refusably, to lift it into the vault and patch the file.
See [Credentials](docs/credentials.md).

## Documentation

- **[Configuration](docs/configuration.md)** — `config.yml` and `laneyard.yml`.
- **[Accounts](docs/accounts.md)** — the two roles, and which projects a builder reaches.
- **[Credentials](docs/credentials.md)** — hardcoded credentials at setup, secrets, the environment file, signing blocks.
- **[Readiness](docs/readiness.md)** — the per-project checklist, and what a tick means.
- **[Managing a project](docs/managing.md)** — the build number, the Fastfile editor, removing, resetting, uninstalling.
- **[Security](docs/security.md)** — what is encrypted, what is not, and what this does not cover.

## Status

`✓` shipped · `▸` being built · `○` planned

- `✓` declare a project, clone it, list its lanes, run one, watch it live, download the artifact
- `✓` configuration entirely in files you can version and back up
- `✓` adopt an existing fastlane project with one command
- `✓` encrypted secret vault and log redaction
- `✓` build queue, cancellation, timeouts surfaced in the UI
- `✓` a build number per project, handed to every run as `LANEYARD_BUILD_NUMBER` and settable by hand
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

Two things worth knowing: the screens read the clone rather than the remote, so a lane you just
pushed appears after the next run — or after pressing refresh; and runs execute one at a time across
all projects. A queued run survives a server restart and starts on its own.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `npm test` runs the whole suite in
seconds against a fake fastlane, so you can work on any machine, with no Xcode, no signing
certificates and no network.

## Licence

MIT — see [LICENSE](LICENSE).

Built on [fastlane](https://fastlane.tools), and not affiliated with it.

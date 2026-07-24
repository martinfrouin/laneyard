# Readiness

Every project has a Readiness tab: what stands between it and a build that runs while nobody watches.
Only the checks that apply are shown — an Android project is never asked for an App Store Connect key.

Nothing here blocks a build. A red check is never why a run cannot start, and Laneyard never edits a
Fastfile to make its own checklist green.

**What a tick means.** The checks read your Fastfile, following a lane into the methods it defines.
`import`/`import_from_git` and your own `fastlane/actions/` stay out of reach, so a check that found
nothing there says *could not tell* rather than ticking. A green tick means "looked, and it is fine",
never "looked, and saw nothing".

**Literal arguments only.** `match(readonly: true)` is green, `match(readonly: false)` a warning, and
`match(readonly: ENV["RO"])` undetermined — it has no value until the lane runs. A checklist that
guesses gets believed.

## Always

- **the repository** answers `git ls-remote` without asking for credentials — a run that meets a
  password prompt waits rather than fails;
- **dependencies** install: `bundle check` against your Gemfile, or the `fastlane` on the PATH;
- **no lane calls an action known to stop and ask** — `prompt`, `sigh`, `cert`, a writable `match`,
  an upload waiting for confirmation;
- **the variables the lanes read** are in the vault. Every `ENV.fetch("…")` a lane reaches is looked
  up — the commonest way a project that works on your laptop fails on a server is a gitignored
  `fastlane/.env` that never reaches the clone.

  A variable read by a tool the lane shells out to (`sentry-cli` and `SENTRY_AUTH_TOKEN`) is named
  nowhere: a committed `fastlane/.env.example` is read for exactly this, and `required_secrets` in
  `laneyard.yml` covers the rest. One found only in the server's own environment is reported, not
  ticked. A name a signing block exports counts as being in the vault.

## On iOS

- **App Store Connect has an API key.** Only the vault earns a tick — a signing block, or variables
  stored before blocks existed. A `key_filepath` in the lanes or a `.p8` in the repository is
  *could not tell*: a path says a key was arranged, not that it is on this machine. An Appfile with
  only an `apple_id` is a warning — that is the account two-factor will stop the run for.
  `APP_STORE_CONNECT_API_KEY_P8` is called out rather than accepted: no fastlane action reads it;
- **match** has its `MATCH_PASSWORD` stored and is `readonly`, so it fetches rather than creates.

## On Android

- **the keystore is reachable without a prompt.** A lane handing `gradle` a `storeFile` needs a
  passphrase; one that is neither in the call nor in the vault makes gradle stop and ask. A keystore
  block settles it — file and both passphrases reach the run together;
- **the release is signed with the release key.** The one check whose failure is silent: Flutter's
  snippet signs with the *debug* config when the gitignored `key.properties` is absent, which on a
  build server it always is. The build succeeds, and the store rejects the artifact minutes later
  saying nothing about signing. Laneyard reads the Gradle file as text and says so before the build —
  and, for a project whose keystore is stored here, writes that `key.properties` for the length of
  the run, marked `# written by laneyard, do not commit`. A file of your own is never touched;
- **the Play Store service account** is there when a lane calls `upload_to_play_store`. The vault
  first, then the `json_key` argument, then the Appfile. Only the vault is a tick.

Checks run when you open the tab or press refresh, never on their own — they shell out to git and
bundler. The last run's time is on screen: a stale green tick is worse than a red cross.

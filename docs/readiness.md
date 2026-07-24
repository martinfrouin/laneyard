# Readiness


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


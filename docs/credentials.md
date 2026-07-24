# Credentials

## Hardcoded credentials at setup

After `Project "x" is set up` prints, setup offers — one at a time, refusably — to lift credentials
your Fastfile names outright into the vault, and patch the file to read a variable instead. The
project already works at that point, so declining everything costs nothing.

```diff
-  upload_to_play_store(json_key: "./play-service-account.json", track: "beta")
+  upload_to_play_store(json_key: ENV.fetch("SUPPLY_JSON_KEY"), track: "beta")
```

That path builds on one laptop and nowhere else: Laneyard builds from a clone, so the file is either
gitignored (absent, the run fails) or committed (a key in your history).

It reads the syntax tree with Prism, not text, and finds three kinds:

- **a path to a credential file** — `key_filepath:`, `json_key:` — offered only when the path is
  really on disk. Defaults to **yes**. A `key_id:`/`issuer_id:` beside it is carried along;
- **contents inline** — `key_content:`, `json_key_data:`. Defaults to **yes**. The keyword is renamed
  too (a block is exported as a *path*, not text);
- **an argument that looks like a secret** — ending in `token`, `password`, `secret`, `api_key`,
  `url`. Defaults to **no**, value masked: false positives are likely here.

The credential args of `app_store_connect_api_key` and Play are also **normalised when they already
read a variable**: `issuer_id: ENV["ASC_ISSUER_ID"]` becomes
`ENV.fetch("APP_STORE_CONNECT_API_KEY_ISSUER_ID")`, the name a signing block exports. Store the
`.p8`/JSON once as a block and the old `ASC_*` secrets can go. A value already reading the right name
is left alone.

`ENV.fetch` rather than `ENV[]`, so a missing variable fails at the top of the lane and names itself.

**Setup does not commit or push.** It prints the `git diff` command and stops — so a patched Fastfile
changes nothing until you push it. It does not take the credential out of your history either; where
`git ls-files` finds the file, it says so, and rotating the key is the fix.

Left alone: heredoc values, and the Android keystore (that lives in Gradle, not the Fastfile). Where
no Ruby can load Prism, setup prints `Fastfile not analysed …` and carries on — the scan is a
service, never a gate.

## Secrets

The variables your lanes read go into an encrypted vault, from a project's Secrets tab. Everything
there belongs to that project alone — nothing is shared with another, and nothing reaches a run that
project did not store.

A secret is write-only: the server never sends a masked value back, so no browser holds one. What you
did not mark secret — `APP_VERSION`, an issuer id — is shown on request, one key at a time. Masking
and unmasking switch which it is without retyping the value.

Each becomes an environment variable for every run of its project, kept out of the logs. A masked
value must be at least four characters (see [Security](security.md)).

## The environment file

Some builds read a **file**, not a variable: `flutter_dotenv` bundles `.env` as an asset,
`--dart-define-from-file=config.json` reads a path at compile time, an `.xcconfig` is a file by
definition. That file is gitignored, Laneyard builds from a clone, so it is never there — and the
build does not fail, it produces an app configured with nothing.

Name it in `laneyard.yml` and tick the variables that belong in it:

```yaml
env_file: .env
```

The tick is on each variable, made where you create it rather than in a list you visit later — a
variable you forget to tick is an empty value in a shipped app with no error to say so. The Secrets
tab shows the file it will write, masked values as dots, so a missing line is visible.

It is written when the run starts and removed when it ends, however it ended, and its first line is
`# written by laneyard, do not commit`. **A file already there without that line is never written
over and never removed** — it is yours. Ticking changes nothing else: a ticked variable still reaches
the run as an environment variable like every other one.

Nothing here is required. Leave `env_file` out and no file is written; a Fastfile that forwards
values itself with `ENV.fetch` needs none of this.

## Signing credentials

A signing credential is not a string: a keystore is bytes Gradle reads through a path, and a `.p8` is
useless without its key id and issuer id. They are stored as **blocks** — one file plus the fields
that make it usable, taken whole or refused.

| block | the file | the fields beside it |
| --- | --- | --- |
| app store connect key | `.p8` | key id, issuer id |
| android upload keystore | `.jks` or `.keystore` | key alias, store password, key password |
| play store service account | JSON | — |

They live in the **signing** part of the Secrets tab, encrypted at rest, and never come back out to a
browser: a stored block shows its file name and nothing more, so replacing one means giving it again
in full. A block belongs to one project, and is admin-only. Five apps under one developer account
each hold their own copy of the key: rotating it means replacing five.

**A block becomes real files for the length of a run**, written to
`~/.laneyard/runs/<run id>/secrets/` (mode `600` in a `700` directory) and removed when the run ends,
however it ended. Every applicable block is written, whether or not the lane looks like it needs one.

**It reaches your lanes under the names your project already reads.** Forms are pre-filled with the
names fastlane declares — `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH`/`_KEY_ID`/`_ISSUER_ID`,
`SUPPLY_JSON_KEY` — and every one is editable. The keystore's names are Laneyard's own
(`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`).
The name you store is the only one exported.

**The keystore block can also supply `key.properties`.** Flutter's build script signs with the debug
config when that gitignored file is absent — which, on a build server, it always is. Laneyard writes
it from the block for the length of the run rather than asking you to change your build script. Where
it goes and what its keys are called are asked on the block.

Only projects that sign need any of this: the three blocks are an offer, not a gate.

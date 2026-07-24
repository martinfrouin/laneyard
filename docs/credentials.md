# Credentials

## What setup does about a credential your Fastfile names outright

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

The credential args of `app_store_connect_api_key` and Play — `key_id`, `issuer_id`, `key_filepath`,
`json_key` — are also normalised when they already read a variable: `issuer_id: ENV["ASC_ISSUER_ID"]`
becomes `ENV.fetch("APP_STORE_CONNECT_API_KEY_ISSUER_ID")`, the name a signing block exports. Store
the `.p8`/JSON once as a block and the old `ASC_*` secrets can go. A value already reading the right
name is left alone.

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


## Secrets

The variables your lanes read go into an encrypted vault, from a project's Secrets tab — global
secrets apply everywhere, a project's own win over them. The files it signs with go in the same
vault as blocks (below).

A secret is write-only: the server never sends a masked value back, so no browser ever holds one.
What you did not mark secret — `APP_VERSION`, an issuer id — is shown on request, one key at a time;
masking and unmasking switch which it is without retyping the value.

Nothing in your lanes has to change afterwards: `key_filepath:` and `json_key:` keep working — a
signing block puts a real file back on disk for the length of a run. A secret becomes an environment
variable for every run of its project, kept out of the logs; a masked value must be at least four
characters (see [Security](security.md)).

## Signing credentials

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


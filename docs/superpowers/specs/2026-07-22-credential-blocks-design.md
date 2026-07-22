# Signing credential blocks

Date: 2026-07-22
Status: approved, not implemented

## The problem

Laneyard stores every credential as a string in one flat list. That works for
`APP_VERSION` and `SENTRY_ORG`. It does not work for the three credentials that
actually sign a release: an App Store Connect `.p8`, a Play service account
JSON, and an Android keystore.

Two failures follow from it.

**A keystore has no string form.** Gradle's `storeFile` is a path to a real
file. A vault that only holds strings cannot supply one, so Android signing has
no supported route at all today.

**The interface offers a name nothing reads.** `Secrets.tsx:23` invites the
user to store their `.p8` under `APP_STORE_CONNECT_API_KEY_P8`. That name does
not appear anywhere in fastlane 2.237. The values fastlane actually reads are
`APP_STORE_CONNECT_API_KEY_KEY` (contents), `..._KEY_FILEPATH` (path),
`..._KEY_ID` and `..._ISSUER_ID`. A user who follows the screen ends up with a
correctly stored secret that no lane will ever see.

Underneath both sits a shape mismatch: these credentials are not key/value
pairs. Each is a file plus the fields that make it usable — an issuer id, an
alias, a passphrase. Stored as loose rows, nothing knows they belong together,
and deleting one leaves a half-dead group that no check can detect.

## Design

### Credentials are their own entity

A `credential` table, unique on `(project_slug, kind)`, with three kinds:

| kind | file | fields |
|---|---|---|
| `apple_asc` | `AuthKey_XXX.p8` | `key_id`, `issuer_id` — identifiers |
| `android_keystore` | `release.keystore.jks` | `key_alias` identifier; `store_password`, `key_password` secrets |
| `play_service_account` | `service-account.json` | none |

An empty `project_slug` means global, as in `secret`. Project shadows global,
reusing the precedence `SecretStore.applicable()` already implements: an App
Store Connect key belongs to an Apple account rather than to an app, so it is
declared once; a keystore belongs to the app and is declared on the project.

Being an entity rather than a naming convention is what makes a block atomic —
validated whole on upload, deleted whole, and knowable. Laneyard can say what it
holds instead of inferring it from variable names.

File bytes are base64-encoded before encryption, because `cipher.ts` takes a
string and a `.jks` is binary. Accessors live on `Vault`. The header of
`vault.ts` promises it is the only component that ever holds plaintext; a second
decrypting site would turn a checkable claim into a hopeful one.

### Exported variable names are editable

Each block proposes the canonical names fastlane reads itself, and every name
can be overridden on the block.

This is not a convenience. Popotheque's Fastfile calls
`ENV.fetch("ASC_KEY_FILEPATH")` — a private name fastlane does not know — and
that repository is out of scope for edits. Fixed canonical names would mean no
existing project can be onboarded without changing its Fastfile first.

### Files are materialised, uniformly

At run preparation, each applicable block writes its file into the run
directory with mode `0600` and exports the configured path variable. The
directory is removed in a `finally`, so a failed or killed run leaves nothing
behind.

Uniform materialisation rather than "contents where possible": the keystore
forces a real file regardless, and one rule is worth more than saving a write
for two of the three kinds.

Passwords and aliases are exported as ordinary environment variables, and the
passwords join `maskedValues()` so a run's output cannot echo them. File
contents are not scrubbed — they never reach the output, and scrubbing a base64
blob would cost every line of every log for nothing.

### Satisfying the Gradle condition

`heuristics/android-signing.ts` already detects the documented Flutter pattern
where a release build silently falls back to the debug key, and already returns
`conditionalOn` — the name of the properties file the signing config depends on.
That information is currently spent on a warning.

When all three hold — an `android_keystore` block exists, `parseAndroidSigning`
reports `releaseCanUseDebugKey`, and it named a `conditionalOn` — Laneyard
writes that properties file into the ephemeral clone, with the four keys of the
documented snippet: `storeFile` pointing at the materialised `.jks`, plus
`storePassword`, `keyPassword`, `keyAlias`.

The rule reads in one sentence: *Laneyard writes the properties file only where
its absence would ship a debug-signed artifact.* No block, or a build that does
not make that bet, and it writes nothing.

**Rejected: patching `build.gradle`.** The Fastfile tags and pushes. A rewritten
build script would make that tag name a source that did not produce the
artifact, and a rebuild from the tag would silently differ. Beyond that,
`android-signing.ts` already concedes that reading this source by regex is
fragile and errs towards silence; editing it by regex is worse, because a failed
read costs a warning while a failed edit costs a broken build — or a build that
passes and signs wrongly, which is the disease.

If `key.properties` coverage ever proves too narrow, the answer is a Gradle
`--init-script`, which overrides the signing config without touching the
repository. Not built now.

**Known limits.** `conditionalOn` gives the file's name, not the property names
inside it. A project reading `keystoreProperties["alias"]` would get an unusable
file. The four names come from the Flutter documentation and cover the
overwhelming majority; readiness must state the assumption rather than hide it.
Separately, `rootProject.file("key.properties")` means `android/` while a
`file(...)` in the module means `android/app/`; the current regex captures both
without distinguishing them, and must start reporting which, or the file lands
in the wrong place half the time.

### Interface

`FILE_CREDENTIALS` and the "from a file" section are removed, superseded.
The page becomes three zones:

- **variables** — plaintext, readable and editable; `reveal()` already exists and
  already refuses masked values.
- **secrets** — write-only strings, the current `••••••`.
- **signing** — one card per block: file drop, associated fields, and the
  exported variable names pre-filled with the canonical ones.

The split between the first two stays the existing `masked` flag. It already
carries exactly this meaning, and `vault.ts:76-80` already argues that the
identifier/secret line is that one. No new concept, two lists instead of one.

### Readiness

The recommendations invert. Where it says "store the JSON as
`SUPPLY_JSON_KEY_DATA`" (`readiness.ts:565`) or "the `.p8` contents" (`:219`),
it will say "add the Play / Apple block". The Android check gains the verdict it
lacks: with the debug fallback detected and a keystore block present, it reports
that Laneyard will supply the properties file, naming the four assumed keys.

### `laneyard.yml` for popotheque

The only file added to that repository:

```yaml
fastlane_dir: app/fastlane
platforms: [ios, android]
required_secrets: [APP_VERSION, SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT]
artifact_globs:
  - app/build/app/outputs/bundle/release/*.aab
  - app/build/ios/ipa/*.ipa
```

Its three blocks are configured with the names its Fastfile already reads —
`ASC_KEY_FILEPATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `SUPPLY_JSON_KEY` — so
nothing in the Fastfile changes.

## Testing

- Round-trip a binary `.jks` through base64, encryption and materialisation, and
  compare bytes with the original.
- A run leaves no file behind after success, after failure, and after a kill.
- Passwords appear as `••••••` in captured output; the base64 blob is absent.
- `parseAndroidSigning` distinguishes `rootProject.file` from a module `file`.
- The properties file is written only under the three conditions, and not
  otherwise.
- Project blocks shadow global ones of the same kind.

## Notes

This design was written against uncommitted work in the repository — 43 modified
files and 15 untracked, including `android-signing.ts` itself. Line references
point at that working tree, not at `34278bc`.

Per the repository's own habit, README and landing page are checked against any
change in what the product claims, once this ships.

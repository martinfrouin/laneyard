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

## The governing constraint

**Laneyard adapts to the project. The project never adapts to Laneyard.**

It is a complement, not a framework. A repository that builds today must keep
building, unedited, the moment it is pointed at Laneyard — no Fastfile changed,
no build script rewritten, no file it did not already have. Anything Laneyard
needs, Laneyard supplies.

This is not an aspiration to keep in mind. It decides three things in this
design that would otherwise have gone the other way, and it condemns three
messages the product ships today.

It decides that **variable names are editable**, because a project that reads
`ASC_KEY_FILEPATH` is not wrong and must not be asked to rename anything. It
decides that **files are materialised** rather than passed as contents, because
a lane written for `key_filepath:` must keep working. And it decides that
Laneyard **writes the Gradle properties file** rather than reporting that the
build script needs fixing.

The three messages it condemns:

- `heuristics/readiness.ts:740-742` tells the user to supply the keystore
  through the environment and make a missing key an error — that is, to rewrite
  their `build.gradle.kts`.
- `heuristics/readiness.ts:469-470` tells them to read the passphrase in the
  lane with `storePassword: ENV[...]` — to rewrite their Fastfile.
- `cli/secret.ts:301-306` tells them to point their lanes at contents instead of
  paths — to rewrite their Fastfile again.

Each replaces an instruction to the user with a statement of what Laneyard will
do. A check may still report that it cannot tell, or that something is genuinely
missing; what it may not do is hand the user homework Laneyard could have done
itself.

`laneyard.yml` is not an exception. Build settings already come "from the
repository or the server" (`config/schema.ts:3`), so a project can be configured
entirely server-side and the file stays a convenience for teams who want the
settings versioned.

### Asking is allowed. Requiring is not.

The constraint forbids changing the project. It does not forbid Laneyard from
asking, once, at configuration time, where something lives.

That distinction is what keeps detection honest. Laneyard reads the repository
to *propose* an answer, and the answer is a field the user can correct — never a
guess it acts on silently, and never a demand that the repository be rearranged
to match what the guess expected.

Two places in this design take that shape rather than the shape they would have
had otherwise:

**Where the properties file goes.** `rootProject.file("key.properties")` means
`android/`; a `file(...)` in the module means `android/app/`. Detection proposes
the scope it read; the block carries the path, editable. A parser that cannot
tell asks instead of choosing wrong.

**What the property names are.** `conditionalOn` gives the file's name, not the
keys inside it. The Flutter documentation's four — `storeFile`, `storePassword`,
`keyPassword`, `keyAlias` — are the defaults, and a project reading
`keystoreProperties["alias"]` changes the field rather than its build script.

The rule for every such field: **detected by default, corrected by the user,
never demanded of the repository.**

### Building is not deploying

A run may exist only to produce an artifact. Someone who wants an `.aab` to hand
to a tester needs the keystore that signs it and nothing else — no `.p8`, no
service account, because nothing is being uploaded anywhere.

So a block is **required by a lane, never by a platform**. Laneyard already
introspects a lane's actions; that is what feeds `ASC_KEY_ACTIONS` and
`PLAY_KEY_ARGS` in the readiness checks today. The same knowledge decides what a
run actually needs:

| a lane calling | needs |
|---|---|
| `upload_to_testflight`, `deliver`, `pilot` | `apple_asc` |
| `upload_to_play_store`, `supply` | `play_service_account` |
| a release Android build | `android_keystore` |
| none of the above | nothing |

A missing block whose kind no lane uses is reported as *not needed here*, not as
a warning. Demanding a service account from someone who only builds is the same
mistake as demanding App Store Connect credentials from a repository that
carries an Xcode project it never builds — a mistake `platforms`
(`config/schema.ts:12-14`) already exists to prevent, applied one level deeper.

**Materialisation does not follow the same rule.** Every applicable block is
written for every run, whether or not the lane appears to need it. Narrowing it
would shrink the window a credential spends on disk, which is worth something —
but a detection that guesses "not needed" and guesses wrong breaks a build that
worked, and under the governing constraint that is the one failure Laneyard may
not cause. Detection decides what to *ask for*, never what to *withhold*.

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

`Vault.resolve()` deliberately swallows a row that will not decrypt, on the
grounds that a rotated key should cost one variable rather than the whole build.
A block does not get that leniency: a keystore that will not decrypt costs a
debug-signed artifact that ships and is rejected days later. An undecryptable
block fails the run, by name, before anything is built.

The routes that create and delete blocks are credential routes, and go in
`REQUIRES_ADMIN` (`src/server/permissions.ts`) — a list whose whole premise is
that it names all of them.

### Exported variable names are editable

Each block proposes the canonical names fastlane reads itself, and every name
can be overridden on the block.

The defaults, per kind:

| kind | variable | default |
|---|---|---|
| `apple_asc` | path | `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH` |
| | key id | `APP_STORE_CONNECT_API_KEY_KEY_ID` |
| | issuer id | `APP_STORE_CONNECT_API_KEY_ISSUER_ID` |
| `play_service_account` | path | `SUPPLY_JSON_KEY` |
| `android_keystore` | path | `ANDROID_KEYSTORE_PATH` |
| | store password | `ANDROID_KEYSTORE_PASSWORD` |
| | key alias | `ANDROID_KEY_ALIAS` |
| | key password | `ANDROID_KEY_PASSWORD` |

Android has no fastlane-canonical names — nothing in fastlane reads a keystore
by convention — so these are Laneyard's. `ANDROID_KEYSTORE_PASSWORD` is chosen
to match the `/(^|_)(KEYSTORE|STORE)_PASSWORD$/` pattern `heuristics/readiness.ts:466`
already recognises, so the check and the block agree by construction rather than
by coincidence.

This is not a convenience. Popotheque's Fastfile calls
`ENV.fetch("ASC_KEY_FILEPATH")` — a private name fastlane does not know — and
that repository is out of scope for edits. Fixed canonical names would mean no
existing project can be onboarded without changing its Fastfile first.

### Files are materialised, uniformly

At run preparation, each applicable block writes its file into a per-run
directory with mode `0600`, and exports the configured path variable. The
directory is removed in a `finally`, so a failed run leaves nothing behind.

That directory is `<home>/runs/<run id>/secrets`, mode `0700` — **not** inside
the clone. The clone is `git`-managed and, per `workspace.ts:14`, kept between
runs; writing credentials into it would both dirty a tree that lanes commit from
and leave keys on disk indefinitely. `executeRun` currently knows only
`workspacePath` and `artifactsDir`, so this is a third path it must be given.

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
writes that properties file, with the four keys of the documented snippet:
`storeFile` as an absolute path into the per-run directory, plus
`storePassword`, `keyPassword`, `keyAlias`.

The rule reads in one sentence: *Laneyard writes the properties file only where
its absence would ship a debug-signed artifact.* No block, or a build that does
not make that bet, and it writes nothing.

This one file cannot live in the per-run directory — Gradle resolves it at a
fixed place relative to the build — so it is the single credential written into
the persistent clone, and it needs three guards.

**A marker.** Its first line is `# written by laneyard, do not commit`. Laneyard
removes such a file in the run's `finally`, and sweeps it again at the start of
every run, so a process killed mid-build cannot leave passwords behind for long.

**Readiness must not read its own writing.** `server/routes/readiness.ts:70-99`
computes
`signingFilePresent` from the clone. A leftover would turn the "absent from the
clone" warning into "present, so the release key is used" — a green verdict
Laneyard manufactured. The check treats a marked file as absent.

**A file without the marker is never touched.** It is the user's own, possibly
their real signing config, and clobbering it would be worse than any warning.
Laneyard leaves it alone and uses it as-is.

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

**Known limits, now configurable.** `conditionalOn` gives the file's name, not
the property names inside it, and cannot distinguish `rootProject` scope from
module scope. Neither is guessed silently: both become fields on the block,
pre-filled from detection and correctable at configuration time, per *Asking is
allowed*. Readiness states which values are in use rather than hiding an
assumption.
Separately, `rootProject.file("key.properties")` means `android/` while a
`file(...)` in the module means `android/app/`. `PROPERTIES_FILE` is run over
the whole source and does not distinguish the two scopes
(`heuristics/android-signing.ts:42, 82`), so `conditionalOn` cannot say where
the file belongs. It must start reporting the scope, or the file lands in the
wrong place half the time. `server/routes/readiness.ts:87-90` inherits the same
blind spot when it looks for the file.

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
`SUPPLY_JSON_KEY_DATA`" (`heuristics/readiness.ts:565`) or "the `.p8` contents" (`:219`),
it will say "add the Play / Apple block". The Android check gains the verdict it
lacks: with the debug fallback detected and a keystore block present, it reports
that Laneyard will supply the properties file, naming the four assumed keys.

`checkAndroidKeystore` (`heuristics/readiness.ts:466-545`) must learn about blocks too.
Today it warns when no key matching the passphrase pattern is stored, and tells
the user to add `ANDROID_KEYSTORE_PASSWORD` to the secrets tab. A user who has
done exactly what this design asks would still get that warning, advising them
to duplicate a password they already gave. The check therefore considers an
applicable `android_keystore` block as satisfying it, and its recommendation
becomes the block rather than a loose secret.

### Existing installations

Nothing is migrated and nothing stops working. Removing `FILE_CREDENTIALS`
removes an upload form, not the rows it created: a secret named
`SUPPLY_JSON_KEY_DATA` remains a valid secret, is still exported, and still
satisfies `checkPlayStore`'s `/^SUPPLY_JSON_KEY/`. Every readiness check accepts
either route — a block or the old loose secrets — and recommends the block only
where neither is present.

The one name that is not carried forward is `APP_STORE_CONNECT_API_KEY_P8`,
because fastlane never read it — the single exception to the rule above, and it
takes a code change to deliver. `checkAppStoreConnect` matches
`/^APP_STORE_CONNECT_API_KEY/` (`heuristics/readiness.ts:215`, used at `:260`),
which prefix-matches the dead name and returns a green "an App Store Connect API
key is in the vault." That regex must be narrowed to exclude the `_P8` suffix,
so the row is reported as a value no lane can see, with the block offered as the
fix. Left as-is, the promised warning does not exist and the manufactured green
tick stays.

This is the only case where a user is asked to redo work, and it is work that
was never doing anything.

The CLI produces the same shape and must move with the interface. `laneyard
secret import` maps `ASC_KEY_FILEPATH` and `APP_STORE_CONNECT_API_KEY_PATH` onto
`APP_STORE_CONNECT_API_KEY_P8` (`src/cli/secret-import.ts:32-38`), minting the
one name this design declares dead. And `src/cli/secret.ts:301-306` advises
"point them at the contents instead — `key_content:` rather than
`key_filepath:`", which inverts the design: blocks materialise a real file
precisely so that `key_filepath` lanes keep working untouched. Both belong in
the same phase as the readiness rewrite, or the product ships two contradictory
instructions.

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

Its blocks are configured in Laneyard's database, not in this file. The Apple
and Play ones take the names that Fastfile already reads — `ASC_KEY_FILEPATH`,
`ASC_KEY_ID`, `ASC_ISSUER_ID`, `SUPPLY_JSON_KEY` — so nothing in the Fastfile
changes. The keystore block keeps the defaults, since no lane reads those names:
Gradle receives them through the properties file instead.

Its Android build only signs correctly because of the properties file. That
repository's `build.gradle.kts` reads nothing but `key.properties` and falls back
to the debug key when it is missing — the exact pattern this design detects — and
it is out of scope for edits.

## Implementation notes

Mechanical facts a plan will hit, verified against the working tree:

- There is no `runs/` tree today; the siblings are `workspaces/<slug>`,
  `artifacts/<runId>` and `logs/` (`server/app.ts:93,99,101`). The new directory
  wants an `AppContext` accessor next to `artifactsDir`.
- `executeRun` has no `try`/`finally` and returns early in six places. "Removed
  in a `finally`" means wrapping the body.
- `maskedValues()` derives entirely from the `secret` table via `maskedKeys` and
  `resolve` (`vault.ts:100-105`). Including block passwords changes that
  signature and its call site (`server/app.ts:146`).
- `Workspace.isDirty()` uses `--untracked-files=no` (`workspace.ts:132-135`), so
  a gitignored properties file cannot trip the dirty guard that would block the
  next run. `RunQueue` is serial (`runner/queue.ts:56-66`), so the shared clone
  has no concurrent-write hazard.
- `Secrets.tsx:47` still says "There is no reveal button anywhere on this screen,
  and no route behind it either." That is already false (`api.revealSecret`,
  `server/routes/secrets.ts:68,105`). The rewrite is the moment to fix it.

## Testing

- Round-trip a binary `.jks` through base64, encryption and materialisation, and
  compare bytes with the original.
- A run leaves no file behind after success, after failure, and after a kill.
- Passwords appear as `••••••` in captured output; the base64 blob is absent.
- `parseAndroidSigning` distinguishes `rootProject.file` from a module `file`.
- The properties file is written only under the three conditions, and not
  otherwise.
- Project blocks shadow global ones of the same kind.
- A marked properties file is swept at the next run's start, and reported as
  absent by readiness in the meantime.
- An unmarked properties file already in the clone is left untouched.
- An undecryptable block fails the run instead of being skipped.
- Old loose secrets keep satisfying every readiness check.

## Phases

The plan should stage this, since a half-landed version must never be one that
signs with the wrong key:

1. Storage — table, migration, `Vault` accessors, permissions.
2. API and interface — three zones, upload, editable names.
3. Run — per-run directory, exported variables, cleanup.
4. Gradle properties file — marker, sweep, readiness agreement.
5. Readiness rewrite and `laneyard.yml` for popotheque.

## Notes

This design was written against uncommitted work in the repository — 43 modified
files and 15 untracked, including `android-signing.ts` itself. Line references
point at that working tree, not at `34278bc`.

Per the repository's own habit, README and landing page are checked against any
change in what the product claims, once this ships.

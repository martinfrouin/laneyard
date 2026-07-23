# Fastfile adoption: hardcoded credentials at setup

Date: 2026-07-23
Status: approved, not implemented

## The problem

A Fastfile that names its credential by a literal path builds fine on the
laptop it was written on, and cannot build anywhere else:

```ruby
app_store_connect_api_key(
  key_filepath: "./AuthKey_9K2LM4XY.p8"
)
```

Laneyard builds from a clone of the remote. Either that `.p8` is gitignored —
in which case it is absent from the clone and the run fails looking for it — or
it is committed, in which case a signing key is in the repository's history and
the run works for the worse reason.

Laneyard cannot help this project today. Everything it has for credentials
hangs off an environment variable name: the sidecar reads `ENV.fetch("X")` out
of the lanes (`ruby/introspect.rb:177`), `required-secrets.ts` collects those
names, `materialise.ts` writes each stored block to disk and exports its path
under the name the project chose. A Fastfile that reads no variable offers
nothing to attach a block to. `laneyard setup` finishes green on a project that
will never build on the server.

The same shape covers a literal Play service account JSON, a `key_content:`
holding a private key inline, and any token passed as a literal to any action.

## What already exists

Nothing below should be reinvented.

- **`ruby/introspect.rb`** parses the Fastfile with Prism, follows a lane into
  the methods that Fastfile defines, and reports each call with its literal
  keyword arguments and the names of the arguments it could not read. It runs
  under the `uses` command, which boots fastlane to enumerate lanes.
- **`src/cli/secret-import.ts`** already reads a working copy's `fastlane/.env`
  and lifts values into the vault, translating a path-valued variable into the
  file's contents where fastlane declares a name for that. It has a
  `suggest-block` outcome for a `.p8`: *the file is real, but nothing here can
  store it — that belongs in a credential block, from the secrets tab.* This
  spec is what closes that sentence.
- **`src/credentials/kinds.ts`** is the one table describing each block kind,
  its fields, and the variable names it exports.
- **`src/runner/materialise.ts`** writes every applicable block to a
  0700 directory for the length of a run, under the project's own variable
  names, and removes it afterwards.
- **`src/fastfile/store.ts`** writes a Fastfile byte-for-byte, verifies it, and
  restores the previous content in place if verification fails.
- **`src/server/routes/fastfile.ts`** exposes that as an editor with a diff, a
  commit and a push — in the workspace clone, from the browser.

## The governing constraint, revisited

`2026-07-22-credential-blocks-design.md` states it:

> **Laneyard adapts to the project. The project never adapts to Laneyard.**

That still holds, and this feature is bounded by it rather than an exception to
it. The distinction it turns on is between *proposing* and *requiring*:

- Laneyard may notice something about a repository and offer a correction.
- Laneyard may not make a working project depend on that correction being taken.

Concretely, declining every proposal in this spec must leave a registered,
usable project — the same one setup produces today, with a readiness line
explaining why that credential path will not survive the clone. Nothing here is
a gate, nothing here blocks a run, and no proposal is applied without being
shown first.

The README's current sentence does not cover this and must be reworded; see
**The discourse** below.

## The scan

`ruby/introspect.rb` gains a `scan` command.

It requires `prism` only. `uses` must boot fastlane to reach
`ff.runner.lanes`; `scan` needs the syntax tree and nothing else. So it runs
under a bare `ruby`, with no `resolveRubyEnv` probe (that probe shells out to
`require "fastlane"` with a 180-second timeout) and no `bundle exec`.

It emits a flat list of findings:

```json
{ "action": "app_store_connect_api_key",
  "arg": "key_filepath",
  "offset": 1204,
  "length": 22,
  "literal": "./AuthKey_9K2LM4XY.p8",
  "tier": "file" }
```

`offset` and `length` come from Prism's `node.location` and delimit the literal
node exactly — quotes included — so the caller can splice without re-finding
anything.

**Ruby's absence is not a failure.** If `ruby` is missing, or `require "prism"`
raises, setup prints one line — the Fastfile was not analysed, and why — and
continues exactly as it does today. The scan is a service, never a gate. This
is the same posture `fastlaneDirIsTracked` already takes: silent when git
cannot answer.

## The rule table

Three tiers. They differ in how confident the scan is and therefore in whether
the proposal starts checked.

| Tier | Recognised | Vault destination | Default |
|---|---|---|---|
| **1 — file** | `app_store_connect_api_key(key_filepath:)`, `supply(json_key:)`, `upload_to_play_store(json_key:)` — literal resolving to a file **that exists on disk** | typed credential block (`apple_asc`, `play_service_account`) | checked |
| **2 — inline contents** | `key_content:`, `json_key_data:` with a literal string — the private key in cleartext in the repository | same block; contents already in hand | checked |
| **3 — literal secret** | any action, argument name matching `token\|password\|secret\|api_key\|url`, non-empty literal value | plain vault entry, name proposed and editable | **unchecked** |

Tier 3 starts unchecked deliberately. It is the only tier where a false
positive is likely — a non-secret URL, a placeholder token — and a patch
applied by default to a value that was not a secret is a silent regression in
someone's build. It is shown, with its value masked, and ticked by hand.

Tier 1 requires the file to exist. A literal path pointing at nothing is
reported as a finding with no proposal attached: there is nothing to lift into
the vault, and patching to a variable that nothing supplies would trade one
broken build for another.

**The Android keystore is out of scope.** It lives in the Gradle build script,
not the Fastfile — `heuristics/android-signing.ts` reads it as text, and
`runner/gradle-properties.ts` already supplies it at run time.

## Producing the patch

**Splice by AST offset.** The scan returns byte offsets; the TypeScript side
replaces those ranges, iterating from the last offset to the first so that
earlier positions stay valid. Everything outside the spliced ranges comes out
byte-identical — the same requirement `fastfile/store.ts` documents, for the
same reason. The splice is a pure function, `(source, findings) => source`, and
its tests need no Ruby.

Rejected:

- **Regex rewriting.** No Ruby needed at scan time, but `key_filepath:` also
  occurs in comments, heredocs, interpolated strings, and as a method a Fastfile
  defines itself. A wrong patch to someone's build file is the worst defect this
  feature could have.
- **Re-emitting from the AST.** Prism does not round-trip faithfully; the file
  would come back reformatted, which the byte-for-byte rule forbids.

The replacement text is `ENV.fetch("<NAME>")`, where `<NAME>` is the tier's
default from `credentials/kinds.ts` — `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH`,
`SUPPLY_JSON_KEY` — or, at tier 3, the name the user accepted at the prompt.
`ENV.fetch` rather than `ENV[]`: a missing variable then fails loudly at the
top of the lane instead of reaching an action as `nil`.

**Tier 2 replaces the keyword as well as the value, and the splice must know
that.** `materialise.ts` stores a block as a file and exports its *path*; there
is no slot that exports contents. So `key_content: "-----BEGIN PRIVATE KEY…"`
cannot become `key_content: ENV.fetch(…)` — that would hand a filesystem path
to an argument expecting PEM text, and the failure would come from inside
fastlane with nothing pointing back here. The finding must therefore carry the
range of the whole `key:value` pair, not just the literal, and the replacement
is `key_filepath: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")`. Same
for `json_key_data:` → `json_key: ENV.fetch("SUPPLY_JSON_KEY")`.

Which means the scan emits a range plus its replacement, not a range plus a
variable name — tiers 1 and 3 happen to replace exactly the literal, and tier 2
does not. Keeping one shape for all three is what stops the splice from having
to know which tier it is serving.

## What setup does

The scan runs once `fastlane directory` is settled — the user may have
corrected it — but everything it proposes happens **after** `Project "x" is set
up` has printed.

That ordering is the guarantee, not a presentation choice. Making the patch a
separate act after setup has succeeded is what makes "declining leaves a working
project" true by construction rather than by promise.

```
Project "popotes" is set up
  …

I read your Fastfile
  fastlane/Fastfile:47   app_store_connect_api_key(key_filepath:)
                         → "./AuthKey_9K2LM4XY.p8"   (the file is there)

  That path does not survive the clone: Laneyard builds from your remote,
  and this .p8 is not in it — or it is, which is worse.

  [x] store the key in this machine's vault
  [x] replace the path with ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")
```

**What it asks.** An `apple_asc` block needs two fields the file does not
carry. The Key ID is offered pre-filled from the filename: `AuthKey_<KEY ID>.p8`
is the convention fastlane's own documentation uses, and `materialise.ts`
already relies on it. The Issuer ID is a UUID that appears nowhere in the file
and must be typed. `play_service_account` has `fields: []` — nothing to ask.
Tier 3 asks for the variable name, proposed and editable.

**Write order is a guarantee.** The vault first, the Fastfile second. If
lifting the file into the vault fails, no Fastfile has been patched to read a
variable nothing supplies. The vault is on this machine, encrypted under
`~/.laneyard/key`; none of it enters the repository.

**Verification.** Splice, then re-parse with Prism. If the file no longer
parses, the previous content is restored before the command answers — the same
contract as `FastfileStore.write`, with a different verifier: setup has no
server to ask fastlane for a lane list, and Prism answers the only question that
matters here.

## What setup does not do

- **It does not commit, push, or `git add`.** It prints the `git diff` and
  stops. The working copy is the user's, possibly mid-branch, and a `setup` that
  commits into someone's repository is the line this product does not cross.
- **It does not remove the credential from the repository.** If `git ls-files`
  sees the file, setup says so in one line — this key is in your history, and
  the patch does not take it out — and touches nothing. Information, not an
  action.
- **It does not narrow what a run materialises.** `materialise.ts` writes every
  applicable block whether or not a lane appears to need it, for the reasons its
  own comment gives. Nothing here changes that.

## The gap between the patch and the build

Laneyard builds from a clone of the remote, so a patched Fastfile in the working
copy changes nothing until it is pushed. This is the trap
`addProjectToConfig` already documents — a project "unreadable from the moment
setup finished until a git push".

Two consequences:

1. Setup's closing message says it plainly: commit and push, or the run still
   reads the old file.
2. The readiness checklist must be able to say the same thing — a project whose
   clone still holds the literal path, while the vault holds the block, should
   read as *pushed?* rather than as a mystery.

## Refusal

Declining every proposal writes nothing to the repository and nothing to the
vault. Setup ends normally, `config.yml` and `laneyard.yml` are written as
today, and the project is registered. The readiness checklist reports the
hardcoded path as a finding, which is exactly what it does for every other thing
it can see and not fix.

## Testing

- The splice function: pure, no Ruby. Multiple findings in one file, overlapping
  ranges refused, byte-identical output outside the ranges, unicode and escaped
  quotes in the literal, and a tier 2 range covering a whole `key: value` pair
  rather than a bare literal.
- The rule table: each tier's recognition, tier 1's file-exists requirement,
  tier 3's default-unchecked state.
- The `scan` sidecar command: offsets landing on the literal exactly, a Fastfile
  with a `key_filepath:` inside a comment producing no finding.
- The Ruby-unavailable path: setup completes, prints its line, writes its two
  config files.
- The refusal path: nothing written anywhere.
- The write-order guarantee: a vault failure leaves the Fastfile untouched.

## Open questions to settle while implementing

- **Can the CLI create a credential block before any server has started?**
  Blocks are born from the web upload route today; `secret-import.ts` only ever
  writes name→value entries. `secrets/vault.ts`, `secrets/key.ts` and
  `db/credentials.ts` are all reachable from the CLI, but whether the database
  is opened and migrated on a machine that has never run the server needs
  checking before this is assumed.
- **Does `require "prism"` succeed on a Mac's system Ruby?** Prism is a default
  gem from Ruby 3.3; macOS has shipped 2.6 for a long time. If it does not, the
  scan falls back to the Ruby-unavailable path more often than expected, and it
  may be worth probing the project's bundled Ruby before the system one.

## The discourse

README line 28 currently reads:

> The adaptation goes one way. A repository that builds today keeps building
> unedited: signing credentials reach your lanes under the variable names your
> Fastfile already reads, and where Laneyard needs to know something no file can
> tell it, it asks on a form rather than asking you to change the file.

It stays true — declining works — but it no longer describes what the product
does. Something closer to:

> The adaptation goes one way. Signing credentials reach your lanes under the
> variable names your Fastfile already reads, and where Laneyard needs to know
> something no file can tell it, it asks on a form. Where it finds a hardcoded
> path that will not survive a clone, it offers a fix and shows you the diff —
> an offer you can decline, and a repository that declines keeps building
> exactly as it did.

The landing page is aligned after the README, per the standing rule that the two
are checked together.

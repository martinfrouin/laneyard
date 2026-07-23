# Fastfile adoption: Apple Key ID and Issuer ID

Date: 2026-07-23
Status: approved, not implemented

Extends [Fastfile adoption](2026-07-23-fastfile-adoption-design.md). Read that
first — the tiers, the scan, and the `runAdoption` flow are unchanged here.

## The problem

Adoption already lifts the `.p8` a Fastfile names by path, and rewrites the
literal to read the variable the stored block exports:

```ruby
app_store_connect_api_key(
  key_id: "9K2LM4XY",                       # left in cleartext
  issuer_id: "6f8e...-....-....",           # left in cleartext
  key_filepath: "./AuthKey_9K2LM4XY.p8",    # rewritten today
)
```

The `key_filepath` is handled; `key_id` and `issuer_id` are not. They are not
files and not secrets, so no tier claims them, and they stay written in the
build file after the key beside them has been put away. The `apple_asc` block
already exports both — `APP_STORE_CONNECT_API_KEY_KEY_ID` and
`..._ISSUER_ID` (see `credentials/kinds.ts`) — so the variables the rewrite
needs already exist; nothing reads them.

## What changes

`key_id` and `issuer_id` literals of `app_store_connect_api_key` are rewritten
to `ENV.fetch("…")`, and their literal values pre-fill the block's fields — but
**only when the same call's `key_filepath` or `key_content` is itself adopted**.
That proposal is what creates the `apple_asc` block that exports the variables;
without it, rewriting an identifier would point the Fastfile at a variable
nothing supplies, trading one broken build for another. An identifier standing
alone (its filepath already coming from an environment variable) is left as it
is.

## Design

**Carried by the block's proposal, not a proposal of its own.** The `file`
(`key_filepath`) or `inline` (`key_content`) proposal for `apple_asc` is the one
thing that creates the block, so it is the one thing that rewrites the
identifiers. This keeps "one block, one decision": the three literals are
accepted or refused together, in one confirmation, and stored in one
`setCredential`.

To carry more than one rewrite, `Proposal.edit: Edit` becomes
`Proposal.edits: Edit[]`. Every existing proposal now holds a one-element array;
an `apple_asc` block proposal holds up to three.

### `src/fastfile/adoption.ts`

- `Proposal.edit` → `Proposal.edits: Edit[]`.
- The identifier literals of `app_store_connect_api_key` (`key_id`,
  `issuer_id`, non-empty) are collected up front.
- When a `file` or `inline` proposal is built for `apple_asc`, each collected
  identifier adds:
  - an edit over the literal's value:
    `key_id: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_ID")`, likewise
    `issuer_id`. The variable name is `defaultVarNames("apple_asc")[arg]`, the
    same table `materialise.ts` exports through.
  - an entry in `suggestedFields`, so the field the block is stored with starts
    filled in. **An explicit literal wins over the Key ID deduced from the
    filename**: `{ ...fromFilename, ...fromLiterals }`.
- No identifier ever produces a proposal of its own; without an adopted
  filepath/content it contributes nothing.

**One-call assumption.** The literals arrive as a flat list with no call
identity, so identifiers are attributed by `action` alone. Two distinct
`app_store_connect_api_key` calls would be merged — but the vault holds exactly
one `apple_asc` block per project, so a second call's key is already
unrepresentable. The limit pre-exists; this does not widen it. Documented in a
comment beside the collection.

### `src/cli/adopt.ts`

- Applying edits: `accepted.flatMap((p) => options.editFor ? [options.editFor(p)] : p.edits)`.
  The `editFor` test seam still forces one breaking edit per proposal, so the
  parse-fails-and-rolls-back path is unchanged.
- `named()` (tier `secret`) rebuilds `edits: [{ ...proposal.edits[0], … }]` — a
  secret always has exactly one edit.
- `store()` is untouched: the block proposal creates the block and
  `suggestedFields` pre-fills `key_id`/`issuer_id` through the existing
  `fieldsOf` loop.

### Play, and the keystore

Unchanged. `json_key` is already adopted and keeps `SUPPLY_JSON_KEY` (the name
fastlane reads natively). `play_service_account` has no identifier fields. The
Android keystore's `gradle-properties.ts` is out of scope.

## Tests

- Three literals (`key_filepath` + `key_id` + `issuer_id`) → one proposal, three
  edits, `suggestedFields` holding both identifiers.
- `key_id` without an adopted `key_filepath`/`key_content` → ignored, no edit.
- An explicit `key_id` literal wins over the one read from the `.p8` filename.
- `key_content` (inline) with identifiers → identifiers rewritten too.
- Existing tests updated: `p.edit` → `p.edits[0]`.

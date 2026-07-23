# Normalise credential step args to Laneyard's names

Date: 2026-07-23
Status: implemented

Extends [Fastfile adoption](2026-07-23-fastfile-adoption-design.md) and
[Apple identifiers](2026-07-23-fastfile-apple-identifiers.md).

## The problem

Adoption only ever rewrote **literal** values. A Fastfile that already reads its
credentials from variables of its own —

```ruby
app_store_connect_api_key(
  key_id:       ENV["ASC_KEY_ID"],
  issuer_id:    ENV["ASC_ISSUER_ID"],
  key_filepath: ENV["ASC_KEY_FILEPATH"],
)
upload_to_play_store(json_key: ENV["PLAY_JSON"])
```

— was left untouched, because `ENV["ASC_ISSUER_ID"]` is a call, not a string
literal, and the scanner reports only literals. The user then had to store
`ASC_*` secrets by hand — secrets that should not exist, since the signing block
already exports the canonical names.

## What changes

For the credential args of `app_store_connect_api_key` and
`supply`/`upload_to_play_store`/`validate_play_store_json_key`, setup rewrites
them to `ENV.fetch("<canonical>")` **always** — literal or `ENV[...]` alike —
where the canonical name is the one the signing block exports
(`credentials/kinds.ts` defaults):

| action | arg | canonical |
| --- | --- | --- |
| `app_store_connect_api_key` | `key_filepath` | `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH` |
| | `key_content` → `key_filepath` | `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH` |
| | `key_id` | `APP_STORE_CONNECT_API_KEY_KEY_ID` |
| | `issuer_id` | `APP_STORE_CONNECT_API_KEY_ISSUER_ID` |
| `supply` / `upload_to_play_store` / `validate_play_store_json_key` | `json_key` | `SUPPLY_JSON_KEY` |
| | `json_key_data` → `json_key` | `SUPPLY_JSON_KEY` |

This **reverses "the project never adapts to Laneyard" for these specific args**,
by explicit request. The pairing: the value the rewrite reaches is only supplied
if the credential is stored as a **signing block** (which exports exactly these
names), not as loose `ASC_*` secrets. Setup's closing report says which blocks to
store; the old `ASC_*` secrets can then be deleted.

## Design

### `ruby/scan.rb` — report ENV lookups, not only literals

The scanner still reports string literals as before, and now also reports values
that are an environment lookup — `ENV["X"]` or `ENV.fetch("X")` — carrying the
value expression's byte range and a `kind` of `"literal"` or `"env"`. `value` is
the unescaped string for a literal and the looked-up name for an env lookup.
Heredocs stay dropped (strings only). Any other value shape (a computed
expression) is still skipped — out of scope, and rare for a credential.

Staying ignorant of credentials: the rule is "report a literal string or an
environment lookup", not "report a credential". `adoption.ts` still decides which
args matter.

### `src/fastfile/adoption.ts` — one credential table, unconditional rewrite

The credential args live in one table (action, arg, kind, slot, optional
keyword-rename). For every occurrence:

- the rewrite to `ENV.fetch("<canonical>")` is **always** emitted, unless the
  value is already exactly that (a no-op is dropped);
- a literal file path that resolves on disk, or inline content, is **also**
  lifted into the block, `key_id`/`issuer_id` literals pre-filling its fields —
  the existing behaviour. An `ENV[...]` value or an off-disk path is a rewrite
  only: nothing to lift.

Per platform, the rewrites group under the block they belong to
(`apple_asc`, `play_service_account`), so one decision covers the block.

### `src/cli/adopt.ts`

A proposal can now rewrite without lifting. The file-lift stays interactive; the
normalisation applies for the known credential args (the user chose "always",
not case-by-case). The closing report names the canonical variables now expected
and reminds to store the matching signing block, and to delete any `ASC_*`
secret it replaces.

## Tests

- `scan.rb`: reports an `ENV["X"]` value with `kind: "env"` and the right byte
  range; still reports literals; still drops heredocs.
- `proposalsFor`: an `ENV[...]` credential arg produces a rewrite to the
  canonical name with no vault lift; a literal-on-disk still lifts; a value
  already canonical produces no edit.
- `runAdoption`: an all-`ENV[...]` Fastfile is normalised without a file to lift,
  and the report names the blocks to store.

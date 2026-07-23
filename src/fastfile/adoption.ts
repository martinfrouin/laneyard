import { defaultVarNames } from "../credentials/kinds.js";
import type { CredentialKind } from "../credentials/kinds.js";
import type { Edit } from "./splice.js";
import type { Literal } from "../sidecar/scan.js";

/**
 * How confident the scan is, which is what decides whether a proposal starts
 * ticked. Never a severity: an inline private key is worse than a hardcoded
 * path, and both are `checked` because both are certain.
 */
export type Tier = "file" | "inline" | "secret";

export interface Proposal {
  tier: Tier;
  /** The credential block this belongs in, absent for a plain vault entry. */
  kind?: CredentialKind;
  /** The vault entry name, for `secret` only. */
  varName: string;
  /** What the file said, for showing and for finding the file on disk. */
  literal: Literal;
  /** Fields the filename gave away, offered pre-filled at the prompt. */
  suggestedFields: Record<string, string>;
  edit: Edit;
  checked: boolean;
}

/** Which action arguments name a credential file, and which block they mean. */
const FILE_ARGS: { action: RegExp; arg: string; kind: CredentialKind }[] = [
  { action: /^app_store_connect_api_key$/, arg: "key_filepath", kind: "apple_asc" },
  { action: /^(supply|upload_to_play_store|validate_play_store_json_key)$/, arg: "json_key", kind: "play_service_account" },
];

/**
 * Arguments holding a credential's *contents* inline, and the argument they
 * must become.
 *
 * The rename is not cosmetic. `materialise.ts` stores a block as a file and
 * exports its *path*; there is no slot that exports contents. Replacing the
 * value alone would hand a filesystem path to an argument expecting PEM text,
 * and fastlane's complaint would point nowhere near here.
 */
const INLINE_ARGS: { action: RegExp; arg: string; becomes: string; kind: CredentialKind }[] = [
  { action: /^app_store_connect_api_key$/, arg: "key_content", becomes: "key_filepath", kind: "apple_asc" },
  { action: /^(supply|upload_to_play_store)$/, arg: "json_key_data", becomes: "json_key", kind: "play_service_account" },
];

/** What a literal secret looks like when nothing more specific matched. */
const SECRET_ARG = /(^|_)(token|password|secret|api_key|url)$/;

/** `AuthKey_<KEY ID>.p8` is the name fastlane's own documentation uses. */
const P8_KEY_ID = /(?:^|\/)AuthKey_([A-Z0-9]+)\.p8$/;

/**
 * Turns what a Fastfile literally says into what could be done about it.
 *
 * Pure, and deliberately so: every judgement about credentials is here, in one
 * function, beside the one table that describes them. `ruby/scan.rb` reports
 * what the file says and knows nothing of any of this.
 *
 * The order of the three passes is the order of confidence. A `json_key`
 * pointing at a literal path is unambiguous; an `api_token` holding a literal
 * might be a real token or might be a placeholder, so it falls through to the
 * unchecked tier rather than being claimed by a rule that was almost right.
 */
export function proposalsFor(literals: Literal[]): Proposal[] {
  const out: Proposal[] = [];

  for (const literal of literals) {
    if (literal.value.trim() === "") continue;

    const file = FILE_ARGS.find((r) => r.action.test(literal.action) && r.arg === literal.arg);
    if (file) {
      const name = defaultVarNames(file.kind)["path"]!;
      out.push({
        tier: "file",
        kind: file.kind,
        varName: name,
        literal,
        suggestedFields: suggestedFields(file.kind, literal.value),
        edit: { start: literal.valueStart, length: literal.valueLength, replacement: `ENV.fetch("${name}")` },
        checked: true,
      });
      continue;
    }

    const inline = INLINE_ARGS.find((r) => r.action.test(literal.action) && r.arg === literal.arg);
    if (inline) {
      const name = defaultVarNames(inline.kind)["path"]!;
      out.push({
        tier: "inline",
        kind: inline.kind,
        varName: name,
        literal,
        suggestedFields: {},
        // The whole pair, because the keyword changes too.
        edit: {
          start: literal.pairStart,
          length: literal.pairLength,
          replacement: `${inline.becomes}: ENV.fetch("${name}")`,
        },
        checked: true,
      });
      continue;
    }

    if (SECRET_ARG.test(literal.arg)) {
      const name = `${literal.action}_${literal.arg}`.toUpperCase();
      out.push({
        tier: "secret",
        varName: name,
        literal,
        suggestedFields: {},
        edit: { start: literal.valueStart, length: literal.valueLength, replacement: `ENV.fetch("${name}")` },
        // Unticked on purpose. This is the one tier where a false positive is
        // likely — a non-secret URL, a placeholder — and a patch applied by
        // default to a value that was not a secret is a silent regression in
        // someone's build.
        checked: false,
      });
    }
  }

  return out;
}

/** What the credential's filename gives away, so the prompt starts filled in. */
function suggestedFields(kind: CredentialKind, path: string): Record<string, string> {
  if (kind !== "apple_asc") return {};
  const keyId = P8_KEY_ID.exec(path)?.[1];
  return keyId ? { key_id: keyId } : {};
}

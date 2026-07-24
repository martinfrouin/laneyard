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

/** One argument a proposal rewrites, and the name it will come to read. */
export interface Rewrite {
  /** The keyword as it will read after the patch — `key_content` becomes `key_filepath`. */
  arg: string;
  /** What that argument says today. */
  literal: Literal;
  varName: string;
}

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
  /**
   * Every rewrite this proposal applies, accepted or refused as one. Usually a
   * single edit; an `apple_asc` block that also names its Key ID or Issuer ID
   * inline carries one per identifier alongside the file rewrite.
   */
  edits: Edit[];
  /**
   * The same rewrites, named — one entry per argument that changes.
   *
   * `edits` are byte ranges, which say nothing on a screen. A proposal touching
   * three arguments used to be announced by the one it was anchored on, so the
   * prompt named `…KEY_FILEPATH` and silently rewrote the two identifiers too.
   */
  rewrites: Rewrite[];
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

  // The App Store Connect identifiers written inline, to be carried by whatever
  // proposal creates the `apple_asc` block. Attributed by action alone: the
  // literals arrive as a flat list with no call identity, and the vault holds
  // one `apple_asc` block per project — so a second `app_store_connect_api_key`
  // call's key is already unrepresentable, and gathering both calls' identifiers
  // here does not widen a limit the block model does not already impose.
  const appleIdentifiers = literals.filter(
    (l) =>
      l.action === "app_store_connect_api_key" &&
      (l.arg === "key_id" || l.arg === "issuer_id") &&
      l.value.trim() !== "",
  );

  for (const literal of literals) {
    if (literal.value.trim() === "") continue;

    const file = FILE_ARGS.find((r) => r.action.test(literal.action) && r.arg === literal.arg);
    if (file) {
      const name = defaultVarNames(file.kind)["path"]!;
      const main = rewriteTo(literal, name);
      const identifiers = file.kind === "apple_asc" ? appleIdentifierRewrites(appleIdentifiers) : EMPTY;
      const edits = [...(main ? [main] : []), ...identifiers.edits];
      const rewrites = [
        ...(main ? [{ arg: literal.arg, literal, varName: name }] : []),
        ...identifiers.rewrites,
      ];
      // Every edit was a no-op — the value already reads its Laneyard name, and
      // so did each identifier. Nothing to propose.
      if (edits.length === 0) continue;
      out.push({
        tier: "file",
        kind: file.kind,
        varName: name,
        // The filename gives a Key ID only for a literal path; an env name is not
        // one. The explicit literal identifier wins over the filename either way.
        suggestedFields: {
          ...(literal.kind === "literal" ? suggestedFields(file.kind, literal.value) : {}),
          ...identifiers.fields,
        },
        literal,
        edits,
        rewrites,
        checked: true,
      });
      continue;
    }

    // Inline contents and a literal secret are, by definition, literals: an
    // `ENV[...]` here is a variable, handled by the file pass above or left alone.
    const inline =
      literal.kind === "literal"
        ? INLINE_ARGS.find((r) => r.action.test(literal.action) && r.arg === literal.arg)
        : undefined;
    if (inline) {
      const name = defaultVarNames(inline.kind)["path"]!;
      const identifiers = inline.kind === "apple_asc" ? appleIdentifierRewrites(appleIdentifiers) : EMPTY;
      out.push({
        tier: "inline",
        kind: inline.kind,
        varName: name,
        suggestedFields: identifiers.fields,
        literal,
        // The whole pair, because the keyword changes too.
        edits: [
          {
            start: literal.pairStart,
            length: literal.pairLength,
            replacement: `${inline.becomes}: ENV.fetch("${name}")`,
          },
          ...identifiers.edits,
        ],
        rewrites: [{ arg: inline.becomes, literal, varName: name }, ...identifiers.rewrites],
        checked: true,
      });
      continue;
    }

    if (literal.kind === "literal" && SECRET_ARG.test(literal.arg)) {
      const name = `${literal.action}_${literal.arg}`.toUpperCase();
      out.push({
        tier: "secret",
        varName: name,
        literal,
        suggestedFields: {},
        edits: [{ start: literal.valueStart, length: literal.valueLength, replacement: `ENV.fetch("${name}")` }],
        rewrites: [{ arg: literal.arg, literal, varName: name }],
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

/** Neither an edit nor a field: an `apple_asc` block that names no identifier. */
const EMPTY: { edits: Edit[]; fields: Record<string, string>; rewrites: Rewrite[] } = {
  edits: [],
  fields: {},
  rewrites: [],
};

/**
 * The rewrites and pre-filled fields for the identifiers written beside an
 * App Store Connect key file.
 *
 * The variable names come from `defaultVarNames("apple_asc")`, the same table
 * `materialise.ts` exports the block's fields through — so the name the Fastfile
 * is patched to read is the name the run will set. These never form a proposal
 * of their own: an identifier is only ever lifted when the key file that anchors
 * its block is, because nothing else exports the variable it would come to read.
 */
function appleIdentifierRewrites(
  identifiers: Literal[],
): { edits: Edit[]; fields: Record<string, string>; rewrites: Rewrite[] } {
  const defaults = defaultVarNames("apple_asc");
  const edits: Edit[] = [];
  const rewrites: Rewrite[] = [];
  const fields: Record<string, string> = {};
  for (const id of identifiers) {
    const name = defaults[id.arg]!;
    const edit = rewriteTo(id, name);
    if (edit) {
      edits.push(edit);
      rewrites.push({ arg: id.arg, literal: id, varName: name });
    }
    // Only a literal is the identifier's value; an env name is the *variable* it
    // was read from, not the id itself, so it pre-fills nothing.
    if (id.kind === "literal") fields[id.arg] = id.value;
  }
  return { edits, fields, rewrites };
}

/**
 * The edit that makes one argument read `varName`, or null when it already does.
 *
 * A literal is always rewritten — a path or a value is never the variable name.
 * An `ENV[...]` already reading that exact name is left alone: the point is to
 * reach Laneyard's name, and it is already there.
 */
function rewriteTo(literal: Literal, varName: string): Edit | null {
  if (literal.kind === "env" && literal.value === varName) return null;
  return {
    start: literal.valueStart,
    length: literal.valueLength,
    replacement: `ENV.fetch("${varName}")`,
  };
}

/** What the credential's filename gives away, so the prompt starts filled in. */
function suggestedFields(kind: CredentialKind, path: string): Record<string, string> {
  if (kind !== "apple_asc") return {};
  const keyId = P8_KEY_ID.exec(path)?.[1];
  return keyId ? { key_id: keyId } : {};
}

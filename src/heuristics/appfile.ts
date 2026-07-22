/**
 * What fastlane's `Appfile` says about credentials.
 *
 * The Appfile is the other half of a fastlane setup, and the half Laneyard used
 * to be blind to: a project whose Play Store service account has been configured
 * for years — `json_key_file` on line two — was told it had no service account,
 * because the only place the checklist looked was Laneyard's own vault. A
 * warning that is false for a working project is worse than no warning: it is
 * the one that teaches someone the screen is wrong and can be skipped.
 *
 * This is a reader, not an evaluator. The Appfile is Ruby and may compute its
 * values — `json_key_file ENV["KEY"]` is legal and common — so anything that is
 * not a plain string literal is reported as "set, but not to something readable
 * from here" rather than guessed at. The checks turn that into `unknown`, which
 * is the honest answer: the value exists, and whether it resolves to a file on
 * this machine is not a question a text file can settle.
 */

/** A value in the Appfile: absent, a literal, or set to something computed. */
export type AppfileValue =
  | { kind: "absent" }
  | { kind: "literal"; value: string }
  | { kind: "computed" };

export interface AppfileFacts {
  /** `json_key_file` — the Play Store service account, as a path. */
  jsonKeyFile: AppfileValue;
  /** `json_key_data` — the same credential, inline. */
  jsonKeyData: AppfileValue;
  /** `apple_id` — the account a lane falls back to, and which asks for a code. */
  appleId: AppfileValue;
}

const ABSENT: AppfileValue = { kind: "absent" };

export const NO_APPFILE: AppfileFacts = {
  jsonKeyFile: ABSENT,
  jsonKeyData: ABSENT,
  appleId: ABSENT,
};

/**
 * Strips comments, so `# json_key_file "old.json"` is not read as a setting.
 *
 * Naive about `#` inside a string, deliberately: the alternative is a Ruby
 * lexer, and the cost of being wrong here is one line read as a comment — the
 * check answers "not found" instead of "found", which is the direction this
 * whole module errs in anyway.
 */
const withoutComments = (line: string): string => line.replace(/#.*$/, "");

/**
 * `json_key_file "x"`, `json_key_file("x")`, `json_key_file 'x'` — and the
 * `for_platform`/`for_lane` blocks they may sit inside, which change nothing
 * about whether the key is set, only about when.
 */
function read(lines: string[], key: string): AppfileValue {
  const declaration = new RegExp(`^\\s*${key}\\s*(\\(|\\s)`);
  const literal = new RegExp(`^\\s*${key}\\s*\\(?\\s*(["'])(.*?)\\1\\s*\\)?\\s*$`);

  let found: AppfileValue = ABSENT;
  for (const line of lines) {
    if (!declaration.test(line)) continue;
    const match = literal.exec(line);
    // A later assignment wins, the way it would when Ruby runs the file — and a
    // literal that follows a computed one is still the value that lands.
    found = match ? { kind: "literal", value: match[2]! } : { kind: "computed" };
  }
  return found;
}

/** Reads an Appfile's text. Never throws: an unreadable Appfile is `NO_APPFILE`. */
export function parseAppfile(content: string): AppfileFacts {
  const lines = content.split("\n").map(withoutComments);
  return {
    jsonKeyFile: read(lines, "json_key_file"),
    jsonKeyData: read(lines, "json_key_data"),
    appleId: read(lines, "apple_id"),
  };
}

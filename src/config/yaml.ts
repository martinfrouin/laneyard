import type { Document } from "yaml";

/**
 * A YAML document back as text, with the line width left alone.
 *
 * The default folds anything past eighty columns, which means writing one
 * project rewraps the password hash someone else's line already held — a
 * hand-written file coming back out changed where nobody touched it. A git url
 * or a scrypt hash is a single token; breaking it makes the file harder to read
 * and harder to grep, and gains nothing.
 *
 * Shared, because config.yml is now edited from three places — setting up a
 * project, adding an account, removing one — and a file that comes back
 * differently depending on which of them touched it is a file nobody trusts.
 */
export const serializeYaml = (doc: Document.Parsed | Document): string =>
  doc.toString({ lineWidth: 0 });

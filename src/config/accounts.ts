import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Document, parseDocument, YAMLSeq } from "yaml";
import { hashPassword } from "../server/auth.js";
import type { UserEntry, UserRole } from "./schema.js";
import { serializeYaml } from "./yaml.js";

/**
 * Accounts, as they are written to and taken out of config.yml.
 *
 * The API and the CLI both go through here, so that "add a builder" means the
 * same thing however it was asked for — including the two refusals, which are
 * decided here rather than twice, differently.
 */

/** Same rule as the schema. Stated once and read from both the API and the CLI. */
export const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * The shortest password that may be stored.
 *
 * Not a policy in the corporate sense — there is no expiry and no character
 * classes. It is the length below which scrypt's cost stops mattering, because
 * the whole space can be walked through faster than one honest login.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Why a change to the accounts must be refused, or null when it may proceed.
 *
 * `role` is the role the account will carry afterwards, or null when it is
 * being removed. Both refusals are the same refusal: a server whose last admin
 * is gone or demoted is a locked room — the interface offers nothing that can
 * put an admin back, and the only way out is editing YAML by hand.
 */
export function refusalFor(
  users: readonly UserEntry[],
  name: string,
  role: UserRole | null,
): string | null {
  const admins = users.filter((u) => u.role === "admin");
  const isLastAdmin = admins.length === 1 && admins[0]!.name === name;
  if (!isLastAdmin || role === "admin") return null;

  return role === null
    ? `${name} is the only admin. Removing them would leave a server nobody can administer — ` +
        "make someone else an admin first."
    : `${name} is the only admin. Demoting them would leave a server nobody can administer — ` +
        "make someone else an admin first.";
}

/** Reads config.yml as a document, or starts an empty one when there is no file. */
async function open(path: string): Promise<Document.Parsed | Document> {
  let doc: Document.Parsed | Document;
  try {
    doc = parseDocument(await readFile(path, "utf8"));
  } catch {
    doc = new Document({});
  }
  if (doc.contents === null) doc = new Document({});
  return doc;
}

/** The accounts sequence, created if the file has none yet. */
function usersSeq(doc: Document.Parsed | Document): YAMLSeq {
  const existing = doc.getIn(["server", "users"]);
  if (existing instanceof YAMLSeq) return existing;
  const seq = new YAMLSeq();
  doc.setIn(["server", "users"], seq);
  return seq;
}

const nameOf = (item: unknown): unknown => (item as { get?: (k: string) => unknown }).get?.("name");

/**
 * Writes an account into config.yml, replacing one of the same name.
 *
 * The edit goes through the YAML document rather than a parse/serialize round
 * trip, for the same reason as every other edit to this file: it is
 * hand-written, and comments and key order must survive being touched.
 *
 * Returns whether the account is new, which is the difference between 201 and
 * 200 and between "created" and "replaced" in a sentence.
 */
export async function upsertUserInConfig(
  path: string,
  entry: { name: string; role: UserRole; password: string },
): Promise<{ created: boolean }> {
  const doc = await open(path);
  const seq = usersSeq(doc);

  const stored: UserEntry = {
    name: entry.name,
    role: entry.role,
    password_hash: hashPassword(entry.password),
  };
  const at = seq.items.findIndex((item) => nameOf(item) === entry.name);
  const node = doc.createNode(stored);
  if (at === -1) seq.add(node);
  else seq.items[at] = node;

  await writeFile(path, serializeYaml(doc), "utf8");
  return { created: at === -1 };
}

/**
 * Takes an account out of config.yml, leaving the rest of the file alone.
 *
 * Returns false when no account carried that name, so the caller can answer 404
 * rather than rewrite the file to say what it already said.
 */
export async function removeUserFromConfig(path: string, name: string): Promise<boolean> {
  const doc = await open(path);
  const users = doc.getIn(["server", "users"]);
  if (!(users instanceof YAMLSeq)) return false;

  const at = users.items.findIndex((item) => nameOf(item) === name);
  if (at === -1) return false;

  users.items.splice(at, 1);
  await writeFile(path, serializeYaml(doc), "utf8");
  return true;
}

/**
 * Does this file already declare somebody?
 *
 * Asked before a question is put to the user rather than after: `laneyard setup`
 * only asks for an admin's name on a machine that has none, and asking anyway
 * and then ignoring the answer would be worse than not asking.
 */
export async function hasAccount(path: string): Promise<boolean> {
  const doc = await open(path);
  return doc.hasIn(["server", "users"]);
}

/**
 * Creates the first admin if the file declares no account at all.
 *
 * Returns the generated password, once, for the caller to print — or null when
 * an account already existed and nothing was written. The password is generated
 * rather than asked for because this runs inside `laneyard setup`, where a
 * prompt for a password would be one more thing to invent while trying to do
 * something else entirely.
 */
export async function ensureFirstAdmin(path: string, name: string): Promise<string | null> {
  const doc = await open(path);
  if (doc.hasIn(["server", "users"])) return null;

  const password = randomBytes(9).toString("base64url");
  doc.setIn(
    ["server", "users"],
    doc.createNode([{ name, role: "admin", password_hash: hashPassword(password) }]),
  );
  await writeFile(path, serializeYaml(doc), "utf8");
  return password;
}

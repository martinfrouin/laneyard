/**
 * Reached across into the server's own source rather than copied. `kinds.ts` is
 * the single table the server, the runner and this interface agree on, and a
 * second copy of it here would be a copy that drifts — a browser offering a
 * kind the server would refuse, or a name no lane reads.
 */
import type { CredentialKind } from "../../src/credentials/kinds";

export type { CredentialKind };

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
  return (await res.json()) as T;
};

/**
 * For the routes that answer 204.
 *
 * The server explains its refusals — a value too short to be redacted, a name
 * that is not a variable name — and that sentence is the whole point: it must
 * reach the screen rather than be flattened into "400".
 */
const empty = async (res: Response): Promise<void> => {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? res.statusText);
};

/**
 * Two roles, and only two. `admin` may do everything; `builder` may start a
 * build, watch it, cancel it and download what it produced — nothing that
 * changes what a build does, and nothing that reveals a credential.
 */
export type Role = "admin" | "builder";

/** Who is signed in. */
export interface Identity {
  name: string;
  role: Role;
}

/**
 * An account as the accounts screen sees it.
 *
 * `projects` is the reach: the slugs a builder may see, `null` when it carries
 * no list at all and so reaches every project (an old config, or an admin — for
 * whom the field is ignored and the checklist not drawn).
 */
export interface Account extends Identity {
  projects: string[] | null;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  color: string;
  lastRun: { id: number; status: string; lane: string; finishedAt: string | null } | null;
}

export interface Lane {
  name: string;
  platform: string | null;
  description: string;
  private: boolean;
}

export interface RunDetail {
  id: number;
  projectSlug: string;
  lane: string;
  status: string;
  /** 1 for the next to start, null when the run is not waiting. */
  queuePosition: number | null;
  branch: string | null;
  commitSha: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorSummary: string | null;
  steps: { idx: number; name: string; durationMs: number | null; status: string; logOffset: number | null }[];
  artifacts: { id: number; filename: string; size: number; kind: string }[];
}

/**
 * What removing a project removed, and what it left alone.
 *
 * `removed` is everything Laneyard held for the project — the one confirmed act
 * clears it all. `untouched` counts the global vault rows it is not allowed to
 * take; the git remote and the credential originals are untouched too, said in
 * prose rather than as a number because there is nothing here to count.
 */
export interface ProjectRemoval {
  slug: string;
  name: string;
  removed: {
    /** Run rows and their logs — the one thing here that cannot be rebuilt. */
    runs: number;
    /** Artifact folders deleted from disk. */
    artifacts: number;
    /** Whether the clone was on disk and is now gone. */
    workspace: boolean;
    /** Slug-scoped secrets forgotten from the vault. */
    secrets: number;
    /** Slug-scoped signing blocks forgotten from the vault. */
    signingBlocks: number;
  };
  /** Shared by every project, so never this removal's to take. */
  untouched: {
    globalSecrets: number;
    globalSigningBlocks: number;
  };
}

/** What a listing may expose. There is deliberately no value here. */
export interface SecretSummary {
  key: string;
  masked: boolean;
  scope: "project" | "global";
}

/**
 * What a signing block's listing may expose: the file's name, never a byte of
 * it, and the names it is exported under. No field value ever comes back — not
 * an issuer id, not a keystore password — so this page has nothing to uncover.
 */
export interface CredentialSummary {
  kind: CredentialKind;
  fileName: string;
  scope: "project" | "global";
  varNames: Record<string, string>;
  updatedAt: string;
}

/** A block as it goes up: taken whole or refused whole, the file included. */
export interface CredentialBlock {
  fileName: string;
  fileBase64: string;
  fields: Record<string, string>;
  varNames: Record<string, string>;
}

/** One line of the readiness checklist. `fix` is a sentence, never a button. */
export interface ReadinessCheck {
  id: string;
  title: string;
  state: "ok" | "warn" | "unknown";
  detail: string;
  fix?: string;
  /** Set only when the fix really is one action, and the tab can lead to it. */
  fixIn?: "secrets";
}

/**
 * The checks that apply to one platform, or to every project.
 *
 * A project only ever receives the sections that apply to it: an Android
 * project is never sent the App Store Connect check, because one irrelevant
 * warning teaches someone to ignore the whole screen.
 */
export interface ReadinessSection {
  platform: "all" | "ios" | "android";
  checks: ReadinessCheck[];
}

export interface Readiness {
  /** When these answers were produced. A checklist with no date is a rumour. */
  checkedAt: string;
  sections: ReadinessSection[];
}

/** The Fastfile as it is on disk, plus what git makes of it. */
export interface FastfileContent {
  /** Byte-for-byte what the file holds — never reformatted on the way here. */
  content: string;
  /** True when the workspace has uncommitted changes to tracked files. */
  dirty: boolean;
  /** The unified diff of the Fastfile alone, empty when it matches HEAD. */
  diff: string;
}

/** Everything uncommitted in the workspace — the Fastfile is usually not alone. */
export interface Changes {
  files: string[];
  diff: string;
}

export const api = {
  login: (name: string, password: string) =>
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.ok),

  /** Who this browser is. A 401 here is what sends the app to the login form. */
  me: () => fetch("/api/me").then(json<Identity>),

  // Ends this session and no other: the same person signed in on a phone stays
  // signed in there. Only removing the account ends every session it has.
  logout: () => fetch("/api/logout", { method: "POST" }).then(empty),

  /**
   * Changes your own password — not `/api/users`, which is the admin list.
   *
   * The current one is sent along even though the cookie already proves who
   * this is: the server asks for it, and the reason is the browser left open on
   * a desk. The reply carries a fresh session cookie, so this page stays signed
   * in while every other session this account had is dropped.
   */
  changeOwnPassword: (current: string, next: string) =>
    fetch("/api/account/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current, next }),
    }).then(empty),

  /**
   * Changes your own name — beside the password, and not `/api/users`, which is
   * the admin list of other people. The current password is sent along for the
   * same reason: the browser may have been left open on a desk. The reply hands
   * back the new name — the old session's cookie is dropped and a fresh one under
   * the new name set — so the header and this page can follow it.
   */
  setAccountName: (current: string, next: string) =>
    fetch("/api/account/name", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current, next }),
    }).then(json<Identity>),

  /**
   * The names this project needs, and which are still missing.
   *
   * Names only. The file that holds the real values is the one that never
   * reaches a clone — that is the problem this reports, not a source to read.
   */
  requiredSecrets: (slug: string) =>
    fetch(`/api/projects/${slug}/required-secrets`).then(
      json<{ required: string[]; missing: string[] }>,
    ),

  /**
   * One secret's value, and only one that was never declared secret.
   *
   * A separate call rather than a field on the listing: a listing that carried
   * values would put every one of them in the browser at once, for a page most
   * people open to check a name. The server refuses a masked value whoever asks.
   */
  revealSecret: (slug: string, key: string) =>
    fetch(`/api/projects/${slug}/secrets/${encodeURIComponent(key)}/value`).then(
      json<{ key: string; value: string }>,
    ),

  /** Turns redaction on or off without touching the value. */
  setSecretMasked: (slug: string, key: string, masked: boolean) =>
    fetch(`/api/projects/${slug}/secrets/${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ masked }),
    }).then(empty),

  users: () => fetch("/api/users").then(json<Account[]>),

  // Sets which projects a builder may reach. The server refuses this for an
  // admin — it reaches everything — and `empty` carries that sentence through.
  setUserProjects: (name: string, projects: string[]) =>
    fetch(`/api/users/${encodeURIComponent(name)}/projects`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projects }),
    }).then(empty),

  // The refusals are sentences — the last admin, a password too short — and
  // `json` carries them to the screen rather than flattening them into a code.
  createUser: (name: string, role: Role, password: string) =>
    fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, role, password }),
    }).then(json<Identity>),

  removeUser: (name: string) =>
    fetch(`/api/users/${encodeURIComponent(name)}`, { method: "DELETE" }).then(empty),

  projects: () => fetch("/api/projects").then(json<ProjectSummary[]>),
  lanes: (slug: string) => fetch(`/api/projects/${slug}/lanes`).then(json<Lane[]>),
  runsOf: (slug: string) => fetch(`/api/projects/${slug}/runs`).then(json<RunDetail[]>),
  run: (id: number) => fetch(`/api/runs/${id}`).then(json<RunDetail>),
  log: (id: number, from = 0) => fetch(`/api/runs/${id}/log?from=${from}`).then((r) => r.text()),

  // Irreversible, so gated by the slug typed back — the server refuses a
  // request that does not carry it, and removes nothing. Refused with 409 while
  // a run of that project is in flight; either sentence is the answer, and
  // `json` carries it through to the screen.
  removeProject: (slug: string) =>
    fetch(`/api/projects/${slug}?confirm=${encodeURIComponent(slug)}`, { method: "DELETE" }).then(
      json<ProjectRemoval>,
    ),

  secrets: (slug: string) => fetch(`/api/projects/${slug}/secrets`).then(json<SecretSummary[]>),

  // Asked for, never polled: on the server side this shells out to git and to
  // bundler. The tab calls it when it opens and when the user presses refresh.
  readiness: (slug: string) => fetch(`/api/projects/${slug}/readiness`).then(json<Readiness>),

  setSecret: (slug: string, key: string, value: string, masked: boolean) =>
    fetch(`/api/projects/${slug}/secrets/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value, masked }),
    }).then(empty),

  deleteSecret: (slug: string, key: string) =>
    fetch(`/api/projects/${slug}/secrets/${encodeURIComponent(key)}`, { method: "DELETE" }).then(empty),

  listCredentials: (slug: string) =>
    fetch(`/api/projects/${slug}/credentials`).then(json<CredentialSummary[]>),

  /**
   * Stores one block. The file rides along base64 in the JSON body rather than
   * as a multipart upload: a `.p8` is two kilobytes, and the browser encodes it
   * in one call, so carrying it that way costs a dependency on both sides for
   * nothing. The server's refusals are sentences — a missing alias, a name that
   * is not a variable name — and `empty` carries them to the screen.
   */
  putCredential: (slug: string, kind: CredentialKind, block: CredentialBlock) =>
    fetch(`/api/projects/${slug}/credentials/${kind}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(block),
    }).then(empty),

  // Removes this project's own block and only that one, so a global block it
  // was shadowing comes back into view — undoing an override, not deleting
  // everyone's key from inside one project.
  deleteCredential: (slug: string, kind: CredentialKind) =>
    fetch(`/api/projects/${slug}/credentials/${kind}`, { method: "DELETE" }).then(empty),

  fastfile: (slug: string) => fetch(`/api/projects/${slug}/fastfile`).then(json<FastfileContent>),

  // The server writes the file, asks fastlane whether it still parses, and puts
  // the previous content back if it doesn't. Its refusal is a sentence about
  // Ruby, which is the only thing that can explain what went wrong — `empty`
  // carries it through instead of flattening it into "400".
  saveFastfile: (slug: string, content: string) =>
    fetch(`/api/projects/${slug}/fastfile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }).then(empty),

  changes: (slug: string) => fetch(`/api/projects/${slug}/changes`).then(json<Changes>),

  commit: (slug: string, message: string) =>
    fetch(`/api/projects/${slug}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }).then(empty),

  push: (slug: string) => fetch(`/api/projects/${slug}/push`, { method: "POST" }).then(empty),

  trigger: (slug: string, lane: string, platform: string | null, params: Record<string, string>) =>
    fetch(`/api/projects/${slug}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane, platform, params }),
    }).then(json<{ id: number; queuePosition: number | null }>),

  cancel: (id: number) => fetch(`/api/runs/${id}/cancel`, { method: "POST" }).then(empty),
};

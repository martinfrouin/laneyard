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

/** Who is signed in. The same shape the accounts listing is made of. */
export interface Identity {
  name: string;
  role: Role;
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
 * What removing a project left behind.
 *
 * Every field is something the action did *not* do: history it kept, files it
 * left where they were. The interface states them before asking, and names them
 * afterwards so they can be removed by hand.
 */
export interface ProjectRemoval {
  slug: string;
  name: string;
  /** Runs still in the database, each reachable at its own URL. */
  runsKept: number;
  /** Absolute paths — the clone, then one folder per run that produced artifacts. */
  leftOnDisk: string[];
}

/** What a listing may expose. There is deliberately no value here. */
export interface SecretSummary {
  key: string;
  masked: boolean;
  scope: "project" | "global";
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

  users: () => fetch("/api/users").then(json<Identity[]>),

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

  // Refused with 409 while a run of that project is in flight, and the sentence
  // saying so is the answer — `json` carries it through to the screen.
  removeProject: (slug: string) =>
    fetch(`/api/projects/${slug}`, { method: "DELETE" }).then(json<ProjectRemoval>),

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

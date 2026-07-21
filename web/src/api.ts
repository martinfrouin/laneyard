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

export interface Readiness {
  /** When these answers were produced. A checklist with no date is a rumour. */
  checkedAt: string;
  checks: ReadinessCheck[];
}

export const api = {
  login: (password: string) =>
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).then((r) => r.ok),

  projects: () => fetch("/api/projects").then(json<ProjectSummary[]>),
  lanes: (slug: string) => fetch(`/api/projects/${slug}/lanes`).then(json<Lane[]>),
  runsOf: (slug: string) => fetch(`/api/projects/${slug}/runs`).then(json<RunDetail[]>),
  run: (id: number) => fetch(`/api/runs/${id}`).then(json<RunDetail>),
  log: (id: number, from = 0) => fetch(`/api/runs/${id}/log?from=${from}`).then((r) => r.text()),

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

  trigger: (slug: string, lane: string, platform: string | null, params: Record<string, string>) =>
    fetch(`/api/projects/${slug}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane, platform, params }),
    }).then(json<{ id: number; queuePosition: number | null }>),

  cancel: (id: number) => fetch(`/api/runs/${id}/cancel`, { method: "POST" }).then(empty),
};

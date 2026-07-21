const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
  return (await res.json()) as T;
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
  branch: string | null;
  commitSha: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorSummary: string | null;
  steps: { idx: number; name: string; durationMs: number | null; status: string; logOffset: number | null }[];
  artifacts: { id: number; filename: string; size: number; kind: string }[];
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

  trigger: (slug: string, lane: string, platform: string | null, params: Record<string, string>) =>
    fetch(`/api/projects/${slug}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane, platform, params }),
    }).then(json<{ id: number }>),
};

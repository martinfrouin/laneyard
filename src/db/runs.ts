import type { Db } from "./open.js";

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Un run est actif tant qu'il n'a pas atteint un état terminal. */
const ACTIVE: RunStatus[] = ["queued", "preparing", "running"];

export interface Run {
  id: number;
  projectSlug: string;
  lane: string;
  platform: string | null;
  params: Record<string, string>;
  status: RunStatus;
  branch: string | null;
  commitSha: string | null;
  interactive: boolean;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorSummary: string | null;
}

export interface Step {
  idx: number;
  name: string;
  durationMs: number | null;
  status: string;
  logOffset: number | null;
  source: "report" | "live";
}

export interface Artifact {
  id: number;
  filename: string;
  path: string;
  size: number;
  kind: string;
}

interface RunRow {
  id: number;
  project_slug: string;
  lane: string;
  platform: string | null;
  params: string;
  status: RunStatus;
  branch: string | null;
  commit_sha: string | null;
  interactive: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error_summary: string | null;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  projectSlug: r.project_slug,
  lane: r.lane,
  platform: r.platform,
  params: JSON.parse(r.params) as Record<string, string>,
  status: r.status,
  branch: r.branch,
  commitSha: r.commit_sha,
  interactive: r.interactive === 1,
  queuedAt: r.queued_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  exitCode: r.exit_code,
  errorSummary: r.error_summary,
});

const now = () => new Date().toISOString();

export class RunStore {
  constructor(private readonly db: Db) {}

  create(input: {
    projectSlug: string;
    lane: string;
    platform: string | null;
    params: Record<string, string>;
    interactive?: boolean;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO run (project_slug, lane, platform, params, status, interactive, queued_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        input.projectSlug,
        input.lane,
        input.platform,
        JSON.stringify(input.params),
        input.interactive ? 1 : 0,
        now(),
      );
    return Number(res.lastInsertRowid);
  }

  get(id: number): Run | null {
    const row = this.db.prepare("SELECT * FROM run WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  listByProject(slug: string, limit = 50): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM run WHERE project_slug = ? ORDER BY id DESC LIMIT ?")
      .all(slug, limit) as RunRow[];
    return rows.map(toRun);
  }

  setStatus(id: number, status: RunStatus): void {
    this.db.prepare("UPDATE run SET status = ? WHERE id = ?").run(status, id);
  }

  markRunning(id: number, git: { branch: string; commitSha: string }): void {
    this.db
      .prepare("UPDATE run SET status = 'running', started_at = ?, branch = ?, commit_sha = ? WHERE id = ?")
      .run(now(), git.branch, git.commitSha, id);
  }

  finish(
    id: number,
    r: { status: RunStatus; exitCode: number | null; errorSummary: string | null },
  ): void {
    this.db
      .prepare("UPDATE run SET status = ?, finished_at = ?, exit_code = ?, error_summary = ? WHERE id = ?")
      .run(r.status, now(), r.exitCode, r.errorSummary, id);
  }

  /** Au démarrage : aucun run ne peut être en cours, le processus qui le portait est mort. */
  interruptActive(): number {
    const placeholders = ACTIVE.map(() => "?").join(", ");
    const res = this.db
      .prepare(`UPDATE run SET status = 'interrupted', finished_at = ? WHERE status IN (${placeholders})`)
      .run(now(), ...ACTIVE);
    return res.changes;
  }

  replaceSteps(runId: number, steps: Step[]): void {
    const del = this.db.prepare("DELETE FROM run_step WHERE run_id = ?");
    const ins = this.db.prepare(
      `INSERT INTO run_step (run_id, idx, name, duration_ms, status, log_offset, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      del.run(runId);
      for (const s of steps) {
        ins.run(runId, s.idx, s.name, s.durationMs, s.status, s.logOffset, s.source);
      }
    })();
  }

  steps(runId: number): Step[] {
    const rows = this.db
      .prepare("SELECT * FROM run_step WHERE run_id = ? ORDER BY idx")
      .all(runId) as {
      idx: number;
      name: string;
      duration_ms: number | null;
      status: string;
      log_offset: number | null;
      source: "report" | "live";
    }[];
    return rows.map((r) => ({
      idx: r.idx,
      name: r.name,
      durationMs: r.duration_ms,
      status: r.status,
      logOffset: r.log_offset,
      source: r.source,
    }));
  }

  addArtifact(runId: number, a: Omit<Artifact, "id">): void {
    this.db
      .prepare("INSERT INTO artifact (run_id, filename, path, size, kind) VALUES (?, ?, ?, ?, ?)")
      .run(runId, a.filename, a.path, a.size, a.kind);
  }

  artifacts(runId: number): Artifact[] {
    return this.db
      .prepare("SELECT id, filename, path, size, kind FROM artifact WHERE run_id = ? ORDER BY filename")
      .all(runId) as Artifact[];
  }
}

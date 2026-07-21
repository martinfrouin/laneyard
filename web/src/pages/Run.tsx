import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { RunDetail } from "../api";
import { Terminal } from "../components/Terminal";
import type { TerminalHandle } from "../components/Terminal";
import { isActive, mark } from "../status";
import { useRunStream } from "../useRunStream";

/** Readable duration, from tenths of a second to hours. */
function elapsed(from: string | null, to: string | null): string {
  if (!from) return "—";
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  if (ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

export function Run() {
  const id = Number(useParams().id);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const terminal = useRef<TerminalHandle>(null);
  const { log, finished } = useRunStream(id);

  // The detail is reloaded as long as the run keeps moving: steps and
  // artifacts don't arrive over the stream, only the raw output does.
  useEffect(() => {
    let stop = false;
    const load = () =>
      api
        .run(id)
        .then((r) => {
          if (stop) return;
          setRun(r);
          if (isActive(r.status)) timer = setTimeout(load, 1500);
        })
        .catch((e: Error) => setError(e.message));

    let timer: ReturnType<typeof setTimeout> | undefined;
    void load();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, finished]);

  // The duration of an in-progress run advances on its own.
  useEffect(() => {
    if (!run || !isActive(run.status)) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [run]);

  if (error) return <p className="status-failed">{error}</p>;
  if (!run) return <p className="dim">loading…</p>;

  return (
    <>
      <div className="run-head panel">
        <span>
          <span className={`mark status-${run.status}`}>{mark(run.status)}</span>{" "}
          <Link to={`/p/${run.projectSlug}`} className="dim">
            {run.projectSlug}
          </Link>{" "}
          <span className="bright">{run.lane}</span>
        </span>
        <span className="dim">
          run <span className="bright">#{run.id}</span>
        </span>
        <span className="dim">
          branch <span className="bright">{run.branch ?? "—"}</span>
        </span>
        <span className="dim">
          commit <span className="bright">{run.commitSha ? run.commitSha.slice(0, 7) : "—"}</span>
        </span>
        <span className="dim">
          duration <span className="bright">{elapsed(run.startedAt, run.finishedAt)}</span>
        </span>
        <span className={`status-${run.status}`}>{run.status}</span>
      </div>

      {run.errorSummary && <p className="status-failed">{run.errorSummary}</p>}

      <div className="run-body">
        <div className="panel">
          <div className="pane-title">
            <span className="section">steps</span>
            <span className="dim">{run.steps.length}</span>
          </div>
          {run.steps.length === 0 && (
            <p className="dim" style={{ padding: "6px 12px" }}>
              {isActive(run.status) ? "spotting in progress…" : "no step recorded"}
            </p>
          )}
          <ul className="steps">
            {run.steps.map((s) => {
              const clickable = s.logOffset !== null;
              return (
                <li
                  key={s.idx}
                  className={clickable ? "clickable" : "inert"}
                  // A step with no offset leads nowhere: it doesn't pretend otherwise.
                  title={clickable ? "view in output" : "unknown position in output"}
                  onClick={clickable ? () => terminal.current?.scrollToOffset(s.logOffset!) : undefined}
                >
                  <span className={`mark status-${s.status}`}>{mark(s.status)}</span>
                  <span className="grow">{s.name}</span>
                  <span className="dim">{s.durationMs === null ? "" : `${(s.durationMs / 1000).toFixed(1)}s`}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <Terminal text={log} handle={terminal} />
      </div>

      {run.artifacts.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="pane-title">
            <span className="section">artifacts</span>
            <span className="dim">{run.artifacts.length}</span>
          </div>
          <ul className="rows" style={{ padding: "0 12px" }}>
            {run.artifacts.map((a) => (
              <li key={a.id}>
                <a className="grow accent" href={`/api/runs/${run.id}/artifacts/${a.id}`} download>
                  ↓ {a.filename}
                </a>
                <span className="dim">{a.kind}</span>
                <span className="dim">{size(a.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

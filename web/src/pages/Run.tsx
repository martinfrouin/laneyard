import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import type { RunDetail } from "../api";
import { ProjectTabs } from "../components/ProjectTabs";
import { Terminal } from "../components/Terminal";
import type { TerminalHandle } from "../components/Terminal";
import { isActive, mark, statusLabel } from "../status";
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
  const navigate = useNavigate();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [again, setAgain] = useState(false);
  const [againError, setAgainError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const terminal = useRef<TerminalHandle>(null);
  const { log, finished } = useRunStream(id);

  // "run again" goes from one run to the next without leaving this screen, so
  // for the first time the component survives a change of run. Everything below
  // is about the run in the address bar; left standing it would be the previous
  // one's head, and its failure, sitting under the new number until the first
  // fetch lands. The output is already handled — `useRunStream` clears its own.
  useEffect(() => {
    setRun(null);
    setError(null);
    setCancelError(null);
    setAgainError(null);
  }, [id]);

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

  // No confirmation dialogue: cancelling a build is cheap and undone by
  // triggering another, and a dialogue on a cheap action teaches people to
  // click through dialogues.
  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancel(id);
      // A waiting run is already cancelled when the call returns; a running one
      // takes a few moments to stop. We re-read rather than guess which.
      setRun(await api.run(id));
    } catch (e) {
      setCancelError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  if (error) return <p className="status-failed">{error}</p>;
  if (!run) return <p className="dim">loading…</p>;

  /**
   * The same lane again, with the parameters this one carried.
   *
   * A retry is a new run and says so — it gets its own number and its own log,
   * and this one keeps the output that explains why it failed. The branch is
   * not carried over: it is resolved from the project at launch, the same as
   * every other way of starting a lane, so retrying a run cannot quietly pin a
   * build to a branch that has since moved on.
   */
  const runAgain = async (): Promise<void> => {
    setAgain(true);
    setAgainError(null);
    try {
      const { id: next } = await api.trigger(run.projectSlug, run.lane, run.platform, run.params);
      navigate(`/r/${next}`);
    } catch (e) {
      setAgainError((e as Error).message);
    } finally {
      setAgain(false);
    }
  };

  return (
    <>
      {/* The run belongs to a project, and this is what says so: every tab of it
          is one click away, including the lanes you came from. */}
      <ProjectTabs slug={run.projectSlug} />

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
        <span className={`status-${run.status}`}>{statusLabel(run.status, run.queuePosition)}</span>
        {/* Offered for as long as there is something to stop, and nowhere else. */}
        {isActive(run.status) && (
          <button onClick={() => void cancel()} disabled={cancelling} title="stop this run">
            cancel
          </button>
        )}
        {/* And its opposite, once there is nothing left to stop. Beside the
            failure it answers, rather than back on the lanes list: a build that
            failed for a reason you have just fixed is the commonest thing to
            want twice, and going and finding the lane again to say so is the
            kind of small friction that makes a screen feel like a dead end. */}
        {!isActive(run.status) && (
          <button onClick={() => void runAgain()} disabled={again} title="start this lane again">
            run again
          </button>
        )}
      </div>

      {cancelError && <p className="status-failed">cancel refused — {cancelError}</p>}
      {againError && <p className="status-failed">launch refused — {againError}</p>}
      {run.errorSummary && <p className="status-failed">{run.errorSummary}</p>}

      <div className="run-body">
        <div className="panel">
          <div className="pane-title">
            <span className="section">steps</span>
            <span className="dim">{run.steps.length}</span>
          </div>
          {run.steps.length === 0 && (
            <p className="dim" style={{ padding: "6px 12px" }}>
              {run.status === "queued"
                ? "not started yet"
                : isActive(run.status)
                  ? "spotting in progress…"
                  : "no step recorded"}
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

        <Terminal
          text={log}
          handle={terminal}
          emptyLabel={run.status === "queued" ? "waiting for its turn…" : undefined}
        />
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

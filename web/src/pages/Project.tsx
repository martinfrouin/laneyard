import { useContext, useEffect, useState } from "react";
import { Link, Outlet, useMatch, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import type { Lane, RunDetail } from "../api";
import { Session } from "../App";
import { ProjectTabs } from "../components/ProjectTabs";
import { mark, statusLabel } from "../status";

export function Project() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const admin = useContext(Session)?.role === "admin";
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [runs, setRuns] = useState<RunDetail[]>([]);
  const [lanesError, setLanesError] = useState<string | null>(null);
  const [loadingLanes, setLoadingLanes] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  /** What the next run will be handed. Null while it is being read. */
  const [nextBuild, setNextBuild] = useState<number | null>(null);
  const [typedBuild, setTypedBuild] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const onFastfile = useMatch("/p/:slug/fastfile") !== null;
  const onSecrets = useMatch("/p/:slug/secrets") !== null;
  const onSigning = useMatch("/p/:slug/signing") !== null;
  const onReadiness = useMatch("/p/:slug/readiness") !== null;
  const onSettings = useMatch("/p/:slug/settings") !== null;
  // Every tab but the first renders the nested route and nothing of its own.
  const onSubTab = onFastfile || onSecrets || onSigning || onReadiness || onSettings;

  useEffect(() => {
    // Reading lanes means going out to the repository. On another tab nobody is
    // waiting for that answer, so it isn't asked for.
    if (onSubTab) return;
    setLanes([]);
    setLanesError(null);
    setLoadingLanes(true);
    api
      .lanes(slug)
      .then(setLanes)
      .catch((e: Error) => setLanesError(e.message))
      .finally(() => setLoadingLanes(false));
    api.runsOf(slug).then(setRuns).catch(() => {});
    setTypedBuild(null);
    setBuildError(null);
    // Quietly: the counter is a detail beside the lanes, and a screen that
    // refused to draw them over it would be the wrong trade.
    api.buildNumber(slug).then((b) => setNextBuild(b.next)).catch(() => setNextBuild(null));
  }, [slug, onSubTab]);

  const saveBuildNumber = async (event: React.FormEvent) => {
    event.preventDefault();
    setBuildError(null);
    try {
      const { next } = await api.setBuildNumber(slug, Number(typedBuild));
      setNextBuild(next);
      setTypedBuild(null);
    } catch (e) {
      // Refused with a sentence — not a whole number, a run in flight holding
      // the number already — and it belongs on screen.
      setBuildError((e as Error).message);
    }
  };

  const trigger = async (lane: Lane) => {
    setTriggering(lane.name);
    setTriggerError(null);
    try {
      const { id } = await api.trigger(slug, lane.name, lane.platform, {});
      navigate(`/r/${id}`);
    } catch (e) {
      // A rejected lane must be visible: the promise doesn't die in silence.
      setTriggerError((e as Error).message);
      setTriggering(null);
    }
  };

  if (onSubTab) {
    return (
      <>
        <ProjectTabs slug={slug} />
        <Outlet />
      </>
    );
  }

  return (
    <>
      <ProjectTabs slug={slug} />

      {/* What the next run will be handed as LANEYARD_BUILD_NUMBER, above the
          lanes because that is the moment it matters: the number is decided
          before the build, or not at all. Settable by an admin — a project
          arriving with a counter its repository already kept starts where that
          one stopped, and an upload made by hand is corrected here. */}
      {nextBuild !== null && (
        <p className="dim">
          next build{" "}
          {typedBuild === null ? (
            <>
              <span className="bright">{nextBuild}</span>{" "}
              {admin && (
                <button onClick={() => setTypedBuild(String(nextBuild))} title="set the next build number">
                  set
                </button>
              )}
            </>
          ) : (
            <form onSubmit={(e) => void saveBuildNumber(e)} style={{ display: "inline" }}>
              <input
                type="number"
                min={1}
                step={1}
                value={typedBuild}
                autoFocus
                onChange={(e) => setTypedBuild(e.target.value)}
                style={{ width: 100 }}
              />{" "}
              <button type="submit">save</button>{" "}
              <button type="button" onClick={() => setTypedBuild(null)}>
                cancel
              </button>
            </form>
          )}
        </p>
      )}
      {buildError && <p className="status-failed">refused — {buildError}</p>}

      <h2 className="section">lanes</h2>
      {/* A lane-reading error is stated, never hidden behind an empty list. */}
      {lanesError && <p className="status-failed">unreadable lanes — {lanesError}</p>}
      {loadingLanes && <p className="dim">reading repository…</p>}
      {!loadingLanes && !lanesError && lanes.filter((l) => !l.private).length === 0 && (
        <p className="dim">no public lane in this Fastfile.</p>
      )}

      <ul className="rows">
        {lanes
          .filter((l) => !l.private)
          .map((l) => (
            <li key={`${l.platform ?? ""}:${l.name}`}>
              <button onClick={() => void trigger(l)} disabled={triggering !== null} title="run">
                ▶
              </button>
              <span className="grow">
                <span className="bright">{l.name}</span>{" "}
                {l.platform && <span className="dim">{l.platform}</span>}
                {l.description && <div className="dim">{l.description}</div>}
              </span>
            </li>
          ))}
      </ul>
      {triggerError && <p className="status-failed">launch refused — {triggerError}</p>}

      <h2 className="section" style={{ marginTop: 20 }}>
        runs
      </h2>
      {runs.length === 0 && <p className="dim">no runs yet.</p>}
      <ul className="rows">
        {runs.map((r) => (
          <li key={r.id}>
            <Link to={`/r/${r.id}`} className="grow">
              <span className={`mark status-${r.status}`}>{mark(r.status)}</span> <span className="dim">#{r.id}</span>{" "}
              {r.lane}
            </Link>
            {/* A queue of three is visible from here, without opening anything. */}
            <span className={`status-${r.status}`}>
              {statusLabel(r.status, r.queuePosition)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

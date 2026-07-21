import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useMatch, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import type { Lane, RunDetail } from "../api";
import { mark } from "../status";

export function Project() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [runs, setRuns] = useState<RunDetail[]>([]);
  const [lanesError, setLanesError] = useState<string | null>(null);
  const [loadingLanes, setLoadingLanes] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const onSecrets = useMatch("/p/:slug/secrets") !== null;

  useEffect(() => {
    // Reading lanes means going out to the repository. On another tab nobody is
    // waiting for that answer, so it isn't asked for.
    if (onSecrets) return;
    setLanes([]);
    setLanesError(null);
    setLoadingLanes(true);
    api
      .lanes(slug)
      .then(setLanes)
      .catch((e: Error) => setLanesError(e.message))
      .finally(() => setLoadingLanes(false));
    api.runsOf(slug).then(setRuns).catch(() => {});
  }, [slug, onSecrets]);

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

  const tabs = (
    <nav className="tabs">
      <NavLink to={`/p/${slug}`} end className={({ isActive }) => (isActive ? "current" : "")}>
        lanes
      </NavLink>
      <NavLink to={`/p/${slug}/secrets`} className={({ isActive }) => (isActive ? "current" : "")}>
        secrets
      </NavLink>
    </nav>
  );

  if (onSecrets) {
    return (
      <>
        {tabs}
        <Outlet />
      </>
    );
  }

  return (
    <>
      {tabs}
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
            <span className={`status-${r.status}`}>{r.status}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

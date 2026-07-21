import { useContext, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useMatch, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import type { Lane, RunDetail } from "../api";
import { Session } from "../App";
import { mark, statusLabel } from "../status";

export function Project() {
  const { slug = "" } = useParams();
  // A builder is shown the tabs a builder can use. The server refuses the other
  // routes regardless — this is what keeps the strip from offering three tabs
  // that would each answer 403.
  const admin = useContext(Session)?.role === "admin";
  const navigate = useNavigate();
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [runs, setRuns] = useState<RunDetail[]>([]);
  const [lanesError, setLanesError] = useState<string | null>(null);
  const [loadingLanes, setLoadingLanes] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const onFastfile = useMatch("/p/:slug/fastfile") !== null;
  const onSecrets = useMatch("/p/:slug/secrets") !== null;
  const onReadiness = useMatch("/p/:slug/readiness") !== null;
  const onSettings = useMatch("/p/:slug/settings") !== null;
  // Every tab but the first renders the nested route and nothing of its own.
  const onSubTab = onFastfile || onSecrets || onReadiness || onSettings;

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
  }, [slug, onSubTab]);

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
      {/* The Fastfile is readable by anyone with a session — a builder who can
          start a lane benefits from seeing what it does — but this tab also
          saves, commits and pushes it, and those are an admin's. */}
      {admin && (
        <NavLink to={`/p/${slug}/fastfile`} className={({ isActive }) => (isActive ? "current" : "")}>
          fastfile
        </NavLink>
      )}
      {admin && (
        <NavLink to={`/p/${slug}/secrets`} className={({ isActive }) => (isActive ? "current" : "")}>
          secrets
        </NavLink>
      )}
      <NavLink to={`/p/${slug}/readiness`} className={({ isActive }) => (isActive ? "current" : "")}>
        readiness
      </NavLink>
      {admin && (
        <NavLink to={`/p/${slug}/settings`} className={({ isActive }) => (isActive ? "current" : "")}>
          settings
        </NavLink>
      )}
    </nav>
  );

  if (onSubTab) {
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

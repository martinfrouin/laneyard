import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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

  useEffect(() => {
    setLanes([]);
    setLanesError(null);
    setLoadingLanes(true);
    api
      .lanes(slug)
      .then(setLanes)
      .catch((e: Error) => setLanesError(e.message))
      .finally(() => setLoadingLanes(false));
    api.runsOf(slug).then(setRuns).catch(() => {});
  }, [slug]);

  const trigger = async (lane: Lane) => {
    setTriggering(lane.name);
    setTriggerError(null);
    try {
      const { id } = await api.trigger(slug, lane.name, lane.platform, {});
      navigate(`/r/${id}`);
    } catch (e) {
      // Une lane refusée doit se voir : la promesse ne meurt pas en silence.
      setTriggerError((e as Error).message);
      setTriggering(null);
    }
  };

  return (
    <>
      <h2 className="section">lanes</h2>
      {/* Une erreur de lecture des lanes est dite, jamais masquée par une liste vide. */}
      {lanesError && <p className="status-failed">lanes illisibles — {lanesError}</p>}
      {loadingLanes && <p className="dim">lecture du dépôt…</p>}
      {!loadingLanes && !lanesError && lanes.filter((l) => !l.private).length === 0 && (
        <p className="dim">aucune lane publique dans ce Fastfile.</p>
      )}

      <ul className="rows">
        {lanes
          .filter((l) => !l.private)
          .map((l) => (
            <li key={`${l.platform ?? ""}:${l.name}`}>
              <button onClick={() => void trigger(l)} disabled={triggering !== null} title="lancer">
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
      {triggerError && <p className="status-failed">lancement refusé — {triggerError}</p>}

      <h2 className="section" style={{ marginTop: 20 }}>
        runs
      </h2>
      {runs.length === 0 && <p className="dim">aucun run pour l'instant.</p>}
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

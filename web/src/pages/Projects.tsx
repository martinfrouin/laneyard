import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { ProjectSummary } from "../api";
import { mark } from "../status";

export function Projects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then(setProjects).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="status-failed">{error}</p>;

  if (projects.length === 0) {
    return (
      <>
        <h2 className="section">projets</h2>
        {/* Un état vide est une consigne, pas une humeur : il donne la commande. */}
        <p className="dim">
          aucun projet. lancez <code>laneyard add</code> depuis le dossier d'un projet pour le
          déclarer.
        </p>
      </>
    );
  }

  return (
    <>
      <h2 className="section">projets</h2>
      <ul className="projects rows">
        {projects.map((p) => (
          <li key={p.slug}>
            <Link to={`/p/${p.slug}`} className="grow">
              <span className={`mark status-${p.lastRun?.status ?? "queued"}`}>
                {mark(p.lastRun?.status)}
              </span>{" "}
              {p.name}
            </Link>
            {p.lastRun && <span className="dim"> {p.lastRun.lane}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

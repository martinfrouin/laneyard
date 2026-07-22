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
        <h2 className="section">projects</h2>
        {/* An empty state is an instruction, not a mood: it gives the command. */}
        <p className="dim">
          no projects. run <code>laneyard setup</code> from a project's folder to
          declare it.
        </p>
      </>
    );
  }

  return (
    <>
      <h2 className="section">projects</h2>
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

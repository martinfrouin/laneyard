import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Login } from "./components/Login";
import { ThemeToggle } from "./components/ThemeToggle";
import { Project } from "./pages/Project";
import { Projects } from "./pages/Projects";
import { Run } from "./pages/Run";
import { api } from "./api";
import type { ProjectSummary } from "./api";
import { mark } from "./status";

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  // Un 401 sur cet appel signifie qu'il faut se connecter.
  const load = () =>
    api
      .projects()
      .then((p) => {
        setProjects(p);
        setAuthenticated(true);
      })
      .catch(() => setAuthenticated(false));

  useEffect(() => {
    void load();
  }, []);

  if (authenticated === null) return <p className="dim">chargement…</p>;
  if (!authenticated) return <Login onSuccess={() => void load()} />;

  return (
    <div className="shell">
      <header>
        <span className="brand">laneyard</span>
        <ThemeToggle />
      </header>

      <nav>
        <p className="section nav-head">projets</p>
        {projects.length === 0 && <p className="dim nav-item">aucun</p>}
        {projects.map((p) => (
          <NavLink
            key={p.slug}
            to={`/p/${p.slug}`}
            className={({ isActive }) => `nav-item${isActive ? " current" : ""}`}
          >
            <span className={`mark status-${p.lastRun?.status ?? "queued"}`}>{mark(p.lastRun?.status)}</span>{" "}
            {p.name}
          </NavLink>
        ))}
      </nav>

      <main>
        <Routes>
          <Route path="/" element={<Projects />} />
          <Route path="/p/:slug" element={<Project />} />
          <Route path="/r/:id" element={<Run />} />
          <Route path="*" element={<p className="dim">page inconnue.</p>} />
        </Routes>
      </main>
    </div>
  );
}

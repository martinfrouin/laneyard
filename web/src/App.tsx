import { createContext, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Login } from "./components/Login";
import { ThemeToggle } from "./components/ThemeToggle";
import { Fastfile } from "./pages/Fastfile";
import { Project } from "./pages/Project";
import { Projects } from "./pages/Projects";
import { Readiness } from "./pages/Readiness";
import { Run } from "./pages/Run";
import { Secrets } from "./pages/Secrets";
import { Settings } from "./pages/Settings";
import { api } from "./api";
import type { ProjectSummary } from "./api";
import { mark } from "./status";

/**
 * Told when the set of projects has changed under the app.
 *
 * The sidebar is read once, at the top: a page that removes a project has no
 * other way to make it leave the list. A context rather than a prop because the
 * only caller is three routes deep, and threading a callback through two
 * components that have no use for it would say something false about them.
 */
export const ProjectsChanged = createContext<() => void>(() => {});

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  // A 401 on this call means it's time to log in.
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

  if (authenticated === null) return <p className="dim">loading…</p>;
  if (!authenticated) return <Login onSuccess={() => void load()} />;

  return (
    <ProjectsChanged.Provider value={() => void load()}>
      <div className="shell">
        <header>
          <span className="brand">laneyard</span>
          <ThemeToggle />
        </header>

        <nav>
          <p className="section nav-head">projects</p>
          {projects.length === 0 && <p className="dim nav-item">none</p>}
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
            {/* The tabs live in Project, which renders either its own content or
                the nested route's — so the strip is the same on both. */}
            <Route path="/p/:slug" element={<Project />}>
              <Route path="fastfile" element={<Fastfile />} />
              <Route path="secrets" element={<Secrets />} />
              <Route path="readiness" element={<Readiness />} />
              <Route path="settings" element={<Settings />} />
            </Route>
            <Route path="/r/:id" element={<Run />} />
            <Route path="*" element={<p className="dim">unknown page.</p>} />
          </Routes>
        </main>
      </div>
    </ProjectsChanged.Provider>
  );
}

import { createContext, useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { Login } from "./components/Login";
import { ThemeToggle } from "./components/ThemeToggle";
import { Account } from "./pages/Account";
import { Fastfile } from "./pages/Fastfile";
import { Project } from "./pages/Project";
import { Projects } from "./pages/Projects";
import { Readiness } from "./pages/Readiness";
import { Run } from "./pages/Run";
import { Secrets } from "./pages/Secrets";
import { Settings } from "./pages/Settings";
import { Signing } from "./pages/Signing";
import { Users } from "./pages/Users";
import { api } from "./api";
import type { Identity, ProjectSummary } from "./api";
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

/**
 * Who is signed in, for the screens that show less to a builder.
 *
 * Hiding is courtesy, never security: the server refuses an admin route
 * whatever this says, and its tests prove it. What this buys is a screen with
 * nothing on it that would only ever answer 403.
 */
export const Session = createContext<Identity | null>(null);

/**
 * Told when who is signed in has changed under the app.
 *
 * The one thing that changes it from inside the app is the account page renaming
 * itself: the server sets a fresh cookie under the new name, and this is how the
 * header stops showing the old one. A context rather than a prop for the same
 * reason as `ProjectsChanged` — the only caller is a route deep, and threading a
 * callback to it through components with no use for it would say something false.
 */
export const SessionChanged = createContext<() => void>(() => {});

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checked, setChecked] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  // A 401 on either call means it's time to log in.
  const load = () =>
    api
      .me()
      .then(async (who) => {
        setIdentity(who);
        setProjects(await api.projects().catch(() => []));
      })
      .catch(() => setIdentity(null))
      .finally(() => setChecked(true));

  useEffect(() => {
    void load();
  }, []);

  const signOut = () => {
    void api.logout().finally(() => setIdentity(null));
  };

  if (!checked) return <p className="dim">loading…</p>;
  if (!identity) return <Login onSuccess={() => void load()} />;

  const admin = identity.role === "admin";

  return (
    <Session.Provider value={identity}>
      <SessionChanged.Provider value={() => void load()}>
      <ProjectsChanged.Provider value={() => void load()}>
        <div className="shell">
          <header>
            <span className="brand">laneyard</span>
            {/* Who you are, in the same line grammar as everything else: a
                marker for the role, the name, then the controls. */}
            <span className="who">
              <span className={`mark ${admin ? "accent" : "dim"}`}>{admin ? "●" : "○"}</span>
              {/* The name used to be the only way in, on the assumption that
                  whoever wants to change their password looks for themselves on
                  screen first. Usage said otherwise: a name is a fact, not a
                  control, and the label that said so was a hover title nobody
                  hovers. It stays a link — someone who did click it was not
                  wrong — but the words are on screen beside it now. */}
              <Link to="/account" className="bright">
                {identity.name}
              </Link>
              <span className="dim">{identity.role}</span>
              <Link to="/account" className="account-link">
                your account
              </Link>
              <button onClick={signOut}>sign out</button>
              <ThemeToggle />
            </span>
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

            {admin && (
              <>
                <p className="section nav-head" style={{ marginTop: 16 }}>
                  server
                </p>
                <NavLink to="/users" className={({ isActive }) => `nav-item${isActive ? " current" : ""}`}>
                  <span className="mark dim">●</span> accounts
                </NavLink>
              </>
            )}
          </nav>

          <main>
            <Routes>
              <Route path="/" element={<Projects />} />
              {/* The tabs live in Project, which renders either its own content or
                  the nested route's — so the strip is the same on both. */}
              <Route path="/p/:slug" element={<Project />}>
                {/* The four that would only ever answer 403 to a builder are
                    not routed for one. Courtesy again: `permissions.ts` is what
                    actually refuses them, whatever address is typed. */}
                {admin && <Route path="fastfile" element={<Fastfile />} />}
                {admin && <Route path="secrets" element={<Secrets />} />}
                {admin && <Route path="signing" element={<Signing />} />}
                <Route path="readiness" element={<Readiness />} />
                {admin && <Route path="settings" element={<Settings />} />}
              </Route>
              <Route path="/r/:id" element={<Run />} />
            {/* Every role, unlike /users: this is your own password, not the
                server's list of people. */}
            <Route path="/account" element={<Account />} />
              {/* Routed for an admin only. A builder who types the address gets
                  the unknown-page line rather than a screen of refusals — and
                  the routes behind it refuse them all the same. */}
              {admin && <Route path="/users" element={<Users />} />}
              <Route path="*" element={<p className="dim">unknown page.</p>} />
            </Routes>
          </main>
        </div>
      </ProjectsChanged.Provider>
      </SessionChanged.Provider>
    </Session.Provider>
  );
}

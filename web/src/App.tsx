import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { Login } from "./components/Login";
import { api } from "./api";

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    // Un 401 sur le premier appel signifie qu'il faut se connecter.
    api
      .projects()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);

  if (authenticated === null) return <p className="dim">chargement…</p>;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  return (
    <div className="shell">
      <header>laneyard</header>
      <Routes>
        <Route path="/" element={<p className="dim">projets</p>} />
      </Routes>
    </div>
  );
}

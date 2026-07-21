import { useContext, useEffect, useState } from "react";
import { api } from "../api";
import type { Identity, Role } from "../api";
import { Session } from "../App";

/**
 * The accounts on this server.
 *
 * Reached only by an admin, and only because the sidebar shows the link to one
 * — but that is courtesy, not security: every route this page calls is on the
 * server's admin list, and refuses a builder whatever this page chooses to
 * draw. No password ever comes back here; the listing is names and roles.
 */
export function Users() {
  const me = useContext(Session);
  const [users, setUsers] = useState<Identity[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("builder");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .users()
      .then((u) => {
        setUsers(u);
        setListError(null);
      })
      .catch((e: Error) => setListError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.createUser(name.trim(), role, password);
      // The password leaves the field as soon as it is stored: nothing to read
      // over a shoulder, and no chance of storing it twice under another name.
      setName("");
      setPassword("");
      setRole("builder");
      load();
    } catch (e) {
      // The server refuses the last admin's demotion, a short password, a name
      // that is not a name — each with a sentence. That sentence is the answer.
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (account: Identity) => {
    setFormError(null);
    try {
      await api.removeUser(account.name);
      load();
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <>
      <h2 className="section">accounts</h2>
      <p className="dim">
        who can sign in to this server. an admin can do everything; a builder starts a build,
        watches it, cancels it and downloads what it produced — and never sees a secret.
      </p>

      {listError && <p className="status-failed">unreadable accounts — {listError}</p>}
      {loading && <p className="dim">reading configuration…</p>}

      <ul className="rows">
        {users.map((u) => (
          <li key={u.name}>
            {/* ● everything, ○ what a build needs. Same grammar as a run's line:
                the state is a character, and the colour says nothing else. */}
            <span className={`mark ${u.role === "admin" ? "accent" : "dim"}`}>
              {u.role === "admin" ? "●" : "○"}
            </span>
            <span className="grow">
              <span className="bright">{u.name}</span>{" "}
              {u.name === me?.name && <span className="dim">you</span>}
            </span>
            <span className="dim">{u.role}</span>
            {u.name === me?.name ? (
              // Removing the account you are reading this page with would log
              // you out mid-sentence. Signing out is the control for leaving,
              // and another admin is the one who removes you.
              <span className="dim" title="sign out to leave; another admin removes an account">
                —
              </span>
            ) : (
              <button onClick={() => void remove(u)} title="remove">
                ✗
              </button>
            )}
          </li>
        ))}
      </ul>

      <h2 className="section" style={{ marginTop: 20 }}>
        add
      </h2>
      <form className="secret-form" onSubmit={(e) => void submit(e)}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          spellCheck={false}
          autoComplete="off"
          aria-label="name"
        />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="role">
          <option value="builder">builder</option>
          <option value="admin">admin</option>
        </select>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          autoComplete="new-password"
          aria-label="password"
        />
        <button type="submit" disabled={saving || name.trim() === "" || password === ""}>
          create
        </button>
      </form>
      <p className="dim">
        the account is written to this machine's config.yml, its password hashed. an existing name
        is replaced — and its open sessions end.
      </p>
      <p className="dim">
        removing an account ends its sessions at once. the last admin can be neither removed nor
        demoted: a server nobody can administer cannot be repaired from here.
      </p>

      {formError && <p className="status-failed">refused — {formError}</p>}
    </>
  );
}

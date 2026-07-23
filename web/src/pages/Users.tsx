import { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Account, ProjectSummary, Role } from "../api";
import { Session } from "../App";

/**
 * The accounts on this server.
 *
 * Reached only by an admin, and only because the sidebar shows the link to one
 * — but that is courtesy, not security: every route this page calls is on the
 * server's admin list, and refuses a builder whatever this page chooses to
 * draw. No password ever comes back here; the listing is names, roles and the
 * projects each builder may reach.
 */
export function Users() {
  const me = useContext(Session);
  const [users, setUsers] = useState<Account[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("builder");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([api.users(), api.projects()])
      .then(([u, p]) => {
        setUsers(u);
        setProjects(p);
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

  const remove = async (account: Account) => {
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
        who can sign in to this server. an admin does everything and reaches every project; a builder
        starts, watches, cancels and downloads a build, reaches only the projects granted below, and
        never sees a secret.
      </p>

      {listError && <p className="status-failed">unreadable accounts — {listError}</p>}
      {loading && <p className="dim">reading configuration…</p>}

      <ul className="rows">
        {users.map((u) => (
          <li key={u.name} style={{ flexWrap: "wrap" }}>
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
              // you out mid-sentence, so this row cannot carry the ✗ the others
              // do — it used to carry a dash instead, and dead-ended there. An
              // admin looking for their own password looks at the list of
              // people first, because there is one; the row now leads where it
              // was always going to lead. Changing a password is still not done
              // from this table: this page is the server's list of people, and
              // that is one person.
              <Link to="/account" className="account-link">
                your account
              </Link>
            ) : (
              <button onClick={() => void remove(u)} title="remove">
                ✗
              </button>
            )}
            {/* An admin reaches everything, so it is offered nothing to tick;
                a builder's grants are the checklist below its row. */}
            {u.role === "builder" && (
              <AccountProjects account={u} projects={projects} onError={setFormError} />
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
        is replaced — and its open sessions end. a new builder starts reaching no project until you
        grant it one.
      </p>
      <p className="dim">
        removing an account ends its sessions at once. the last admin can be neither removed nor
        demoted: a server nobody can administer cannot be repaired from here. your own row leads to
        your account, where you change your password — nobody's password is changed from this page,
        and another admin is the one who removes you.
      </p>

      {formError && <p className="status-failed">refused — {formError}</p>}
    </>
  );
}

/**
 * A builder's project grants, one checkbox per project.
 *
 * The account's current grants are ticked. Saving PUTs the ticked slugs, which
 * the server writes to config.yml and the reach check reads on the next request.
 *
 * An account with no list at all (`projects: null`) reaches every project — an
 * old config the feature has not touched. It is shown with every box ticked, so
 * saving is what turns an implicit "everything" into an explicit list the admin
 * then owns; until they save, nothing is written and nothing changes.
 */
function AccountProjects({
  account,
  projects,
  onError,
}: {
  account: Account;
  projects: ProjectSummary[];
  onError: (message: string | null) => void;
}) {
  const initial = account.projects ?? projects.map((p) => p.slug);
  // What is on the server, as this component last knew it: the granted set
  // starts here and returns here after a save, which is what tells a pending
  // change from a saved one.
  const [baseline, setBaseline] = useState<string[]>(initial);
  const [granted, setGranted] = useState<string[]>(initial);
  const [saving, setSaving] = useState(false);

  const has = (slug: string) => granted.includes(slug);
  const toggle = (slug: string) =>
    setGranted((g) => (g.includes(slug) ? g.filter((s) => s !== slug) : [...g, slug]));

  const changed =
    granted.length !== baseline.length || granted.some((s) => !baseline.includes(s));

  const save = async () => {
    setSaving(true);
    onError(null);
    // Written in the projects' own order, so the file reads the way the list
    // does rather than the order boxes happened to be clicked.
    const next = projects.map((p) => p.slug).filter(has);
    try {
      await api.setUserProjects(account.name, next);
      setBaseline(next);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (projects.length === 0) {
    return (
      <span className="dim" style={{ flexBasis: "100%", paddingLeft: "1.5em" }}>
        no projects on this server yet.
      </span>
    );
  }

  return (
    <div style={{ flexBasis: "100%", paddingLeft: "1.5em", marginTop: 4 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25em 1em" }}>
        {projects.map((p) => (
          <label key={p.slug} className="dim" style={{ display: "flex", alignItems: "center", gap: "0.4em" }}>
            <input type="checkbox" checked={has(p.slug)} onChange={() => toggle(p.slug)} />
            <span className={has(p.slug) ? "bright" : "dim"}>{p.name}</span>
          </label>
        ))}
        {changed && (
          <button onClick={() => void save()} disabled={saving}>
            save
          </button>
        )}
      </div>
    </div>
  );
}

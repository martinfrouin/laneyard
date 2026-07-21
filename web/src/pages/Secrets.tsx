import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { SecretSummary } from "../api";

/**
 * The secrets of one project.
 *
 * There is no reveal button anywhere on this screen, and no route behind it
 * either: the server never sends a value back, so the interface has nothing to
 * uncover. The `••••••` is the same marker the logs use — what you see here is
 * exactly what a run's output would show.
 */
export function Secrets() {
  const { slug = "" } = useParams();
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [masked, setMasked] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .secrets(slug)
      .then((s) => {
        setSecrets(s);
        setListError(null);
      })
      .catch((e: Error) => setListError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [slug]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.setSecret(slug, key.trim(), value, masked);
      // The value leaves the field as soon as it is stored: nothing to read over
      // a shoulder, and no chance of storing it twice under another name.
      setKey("");
      setValue("");
      setMasked(true);
      load();
    } catch (e) {
      // The server refuses a value too short to be redacted, and explains why.
      // That sentence is the answer; it is not swallowed into "failed".
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (secret: SecretSummary) => {
    setFormError(null);
    try {
      await api.deleteSecret(slug, secret.key);
      load();
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <>
      <h2 className="section">secrets</h2>
      <p className="dim">
        environment variables for every run of this project. values are encrypted at rest and never
        sent back — not even to this page.
      </p>

      {listError && <p className="status-failed">unreadable secrets — {listError}</p>}
      {loading && <p className="dim">reading vault…</p>}
      {!loading && !listError && secrets.length === 0 && <p className="dim">no secrets yet.</p>}

      <ul className="rows">
        {secrets.map((s) => (
          <li key={s.key}>
            {/* ✓ kept out of the logs, ○ stored as it is and printed as it is. */}
            <span className={`mark ${s.masked ? "accent" : "dim"}`}>{s.masked ? "✓" : "○"}</span>
            <span className="grow">
              <span className="bright">{s.key}</span>{" "}
              <span className="dim">{s.masked ? "••••••" : "shown in the logs"}</span>
            </span>
            {s.scope === "global" ? (
              // A global secret belongs to every project. Editing it from inside
              // one would hide that, so from here it is only ever reported.
              <span className="dim" title="set for every project — laneyard secret set">
                global
              </span>
            ) : (
              <button onClick={() => void remove(s)} title="remove">
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
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="MATCH_PASSWORD"
          spellCheck={false}
          autoComplete="off"
          aria-label="name"
        />
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          autoComplete="new-password"
          aria-label="value"
        />
        <label>
          <input type="checkbox" checked={masked} onChange={(e) => setMasked(e.target.checked)} />
          keep this out of the logs
        </label>
        <button type="submit" disabled={saving || key.trim() === "" || value === ""}>
          store
        </button>
      </form>
      <p className="dim">an existing name is replaced.</p>

      {formError && <p className="status-failed">refused — {formError}</p>}
    </>
  );
}

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { SecretSummary } from "../api";

/**
 * The two credentials the readiness checklist asks for, and that arrive as a
 * file rather than as a string one could sensibly type.
 *
 * The names are the ones fastlane itself reads, and the ones the checklist
 * looks for — a suggestion that stored the key under a name nothing recognises
 * would leave the checklist red and the user certain they had done the work.
 */
const FILE_CREDENTIALS: { key: string; accept: string; what: string }[] = [
  { key: "APP_STORE_CONNECT_API_KEY_P8", accept: ".p8", what: "app store connect key" },
  { key: "SUPPLY_JSON_KEY_DATA", accept: ".json,application/json", what: "play store service account" },
];

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

  // The chosen file, never its contents: it is read at the moment it is sent
  // and the text is not kept anywhere the page could later show it. The page
  // knows the file's name and nothing else about it — the same rule as the
  // list above, where a stored value has no way back to the screen.
  const [file, setFile] = useState<File | null>(null);
  // Bumping this remounts the file controls, which is the only way to empty
  // one: a control still holding a file would not fire again for that same
  // file, and picking it twice must work.
  const [fileControls, setFileControls] = useState(0);

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

  const forgetFile = () => {
    setFile(null);
    setFileControls((n) => n + 1);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      // A `.p8` and a service account JSON are both text. The browser reads the
      // file and sends its text to the same route a typed value goes through:
      // no upload endpoint, no multipart, and the server learns nothing new.
      // The trailing newline every editor leaves goes, because a credential
      // with one is a credential fastlane sometimes rejects.
      const text = file === null ? value : (await file.text()).replace(/\r?\n$/, "");
      await api.setSecret(slug, key.trim(), text, masked);
      // The value leaves the field as soon as it is stored: nothing to read over
      // a shoulder, and no chance of storing it twice under another name.
      setKey("");
      setValue("");
      forgetFile();
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
        {file === null ? (
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            autoComplete="new-password"
            aria-label="value"
          />
        ) : (
          // The file's name, never a preview of what is in it. Same line
          // grammar as a stored secret: marker, name, dim note, ✗ to undo.
          <span className="file-chosen">
            <span className="mark accent">✓</span> <span className="bright">{file.name}</span>{" "}
            <span className="dim">read when you store it</span>{" "}
            <button type="button" onClick={forgetFile} title="choose another value">
              ✗
            </button>
          </span>
        )}
        <label>
          <input type="checkbox" checked={masked} onChange={(e) => setMasked(e.target.checked)} />
          keep this out of the logs
        </label>
        <button type="submit" disabled={saving || key.trim() === "" || (file === null && value === "")}>
          store
        </button>
      </form>

      {/* A credential is a file. Pasting a `.p8` into a text field is the moment
          someone is most likely to paste it somewhere else by accident, and the
          file is right there. Naming the two the checklist asks for is how
          someone arrives with the right one. */}
      <p className="dim">
        or from a file —{" "}
        {FILE_CREDENTIALS.map((c, i) => (
          <span key={`${c.key}-${fileControls}`}>
            {i > 0 && <span className="dim">, </span>}
            <label className="file-pick">
              <input
                type="file"
                accept={c.accept}
                onChange={(e) => {
                  const chosen = e.target.files?.[0] ?? null;
                  if (chosen === null) return;
                  setKey(c.key);
                  setValue("");
                  setFile(chosen);
                  setFormError(null);
                }}
              />
              <span className="accent">{c.what} →</span>
            </label>
          </span>
        ))}
      </p>
      <p className="dim">an existing name is replaced.</p>

      {formError && <p className="status-failed">refused — {formError}</p>}
    </>
  );
}

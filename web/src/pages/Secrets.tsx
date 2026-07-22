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
const FILE_CREDENTIALS: {
  key: string;
  accept: string;
  what: string;
  platform: string;
  extension: string;
}[] = [
  {
    platform: "ios",
    key: "APP_STORE_CONNECT_API_KEY_P8",
    accept: ".p8",
    what: "app store connect key",
    extension: ".p8",
  },
  {
    platform: "android",
    key: "SUPPLY_JSON_KEY_DATA",
    accept: ".json,application/json",
    what: "play store service account",
    extension: ".json",
  },
];

/**
 * Derived rather than written out again: two lists of the same names are two
 * lists that can disagree, and the one that drifts would quietly put a
 * credential back in both places.
 */
const FILE_CREDENTIAL_KEYS = new Set(FILE_CREDENTIALS.map((c) => c.key));

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

    // Alongside, not before: a project whose workspace was never cloned still
    // has a secrets page, and this failing must cost the prompt, not the page.
    api
      .requiredSecrets(slug)
      .then((r) => setMissing(r.missing))
      .catch(() => setMissing([]));
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

  /**
   * Values read one at a time, and forgotten as readily.
   *
   * Kept in a map rather than fetched into the row's own state so that showing
   * one is a deliberate act with a visible opposite: `hide` drops it, and
   * leaving the page drops all of them. Nothing here is ever fetched in bulk.
   */
  const [shown, setShown] = useState<Record<string, string>>({});

  /**
   * The names this project needs but does not have, and what is being typed
   * into each.
   *
   * The names come from the server; the values never do. Someone arriving here
   * has just been told by the checklist that eight variables are missing, and
   * retyping those eight names correctly is a chore where one typo stores a
   * secret nothing will ever read.
   */
  const [missing, setMissing] = useState<string[]>([]);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [storing, setStoring] = useState<string | null>(null);

  const storeMissing = async (name: string) => {
    const value = (typed[name] ?? "").trim();
    if (value === "") return;
    setStoring(name);
    setFormError(null);
    try {
      // Masked, like anything typed into this page: a value that turns out not
      // to be secret costs a redacted line in a log, and the reverse costs a leak.
      await api.setSecret(slug, name, value, true);
      setTyped((prev) => ({ ...prev, [name]: "" }));
      load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setStoring(null);
    }
  };

  const show = async (secret: SecretSummary) => {
    setFormError(null);
    try {
      const { value } = await api.revealSecret(slug, secret.key);
      setShown((prev) => ({ ...prev, [secret.key]: value }));
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  const hide = (key: string) =>
    setShown((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  /**
   * Redaction on or off, without touching the value.
   *
   * The circle this breaks: reading a value means first declaring it not
   * secret, and declaring that by storing it again would mean typing the value
   * you were trying to read.
   */
  const toggleMasked = async (secret: SecretSummary) => {
    setFormError(null);
    try {
      await api.setSecretMasked(slug, secret.key, !secret.masked);
      // A value that has just become secret again must not stay on screen.
      if (!secret.masked) hide(secret.key);
      load();
    } catch (e) {
      setFormError((e as Error).message);
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
      {!loading && !listError && secrets.every((s) => FILE_CREDENTIAL_KEYS.has(s.key)) && (
        <p className="dim">
          {secrets.length === 0 ? "no secrets yet." : "nothing here beyond the two files below."}
        </p>
      )}

      {/* The two file credentials are left out here on purpose: they have a row
          of their own below, carrying their name, whether they are stored and
          the controls for both. Listing them twice was noise, and the two lines
          disagreed about what they offered. */}
      <ul className="rows">
        {secrets.filter((s) => !FILE_CREDENTIAL_KEYS.has(s.key)).map((s) => (
          <li key={s.key}>
            {/* ✓ kept out of the logs, ○ stored as it is and printed as it is. */}
            <span className={`mark ${s.masked ? "accent" : "dim"}`}>{s.masked ? "✓" : "○"}</span>
            <span className="grow">
              <span className="bright">{s.key}</span>{" "}
              {s.masked ? (
                <span className="dim">••••••</span>
              ) : shown[s.key] !== undefined ? (
                <span className="revealed">{shown[s.key]}</span>
              ) : (
                <span className="dim">not a secret</span>
              )}
              {/* The one sentence that explains why a row has no `show`. The
                  redaction and the reading are the same decision seen from two
                  sides — Laneyard treats a secret as one end to end — and a
                  missing button with no reason reads as a missing feature. */}
              {s.masked && (
                <span className="dim"> — kept out of the logs, so never shown here either</span>
              )}
            </span>

            {/* A checkbox, not a verb. This is a property of the secret, and a
                button beside `show` read as a second way of doing the same
                thing. The wording is the form's own, word for word, so the
                thing you tick when storing is the thing you see afterwards. */}
            {s.scope !== "global" && (
              <label className="row-flag" title="a secret is removed from build logs, and never shown here">
                <input
                  type="checkbox"
                  checked={s.masked}
                  onChange={() => void toggleMasked(s)}
                />
                keep out of the logs
              </label>
            )}

            {/* Offered only where it is allowed, which the line above explains. */}
            {!s.masked &&
              s.scope !== "global" &&
              (shown[s.key] === undefined ? (
                <button onClick={() => void show(s)} title="show the value">
                  show
                </button>
              ) : (
                <button onClick={() => hide(s.key)} title="hide it again">
                  hide
                </button>
              ))}
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

      {/* Before the free-form form, because it is the reason most people open
          this page — and because a name that is already on screen is a name
          nobody can mistype. The values are typed here and nowhere else: the
          file that holds the real ones is the one that never reaches a clone. */}
      {missing.length > 0 && (
        <>
          <h2 className="section" style={{ marginTop: 20 }}>
            needed by the lanes
          </h2>
          <p className="dim">
            read by a lane, named in <code>.env.example</code>, or listed under{" "}
            <code>required_secrets</code> — and not stored yet. type the value; the name is already
            the one fastlane looks for.
          </p>
          <ul className="rows needed">
            {missing.map((name) => (
              <li key={name}>
                <span className="mark dim">○</span>
                <span className="needed-name bright">{name}</span>
                <input
                  type="password"
                  className="grow"
                  value={typed[name] ?? ""}
                  onChange={(e) => setTyped((prev) => ({ ...prev, [name]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void storeMissing(name);
                  }}
                  placeholder="value"
                  autoComplete="new-password"
                  aria-label={name}
                />
                <button
                  onClick={() => void storeMissing(name)}
                  disabled={storing !== null || (typed[name] ?? "").trim() === ""}
                >
                  store
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

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
          file is right there.

          These were one sentence — "or from a file — app store connect key,
          play store service account" — which ran the two platforms together in
          a line you had to finish reading to find out that half of it was not
          about you. They are two different credentials, for two different
          stores, and only one of them is usually yours. So: one row each, in
          the same grammar as every other list here, under a heading of its own.

          The name each is stored under is on screen rather than implied. It is
          the name fastlane reads and the name the checklist looks for — storing
          the right file under a name nothing recognises leaves the checklist
          warning and the user certain they had done the work. */}
      <h2 className="section" style={{ marginTop: 20 }}>
        from a file
      </h2>
      <ul className="rows credentials">
        {FILE_CREDENTIALS.map((c) => {
          const storedSecret = secrets.find((s) => s.key === c.key);
          const stored = storedSecret !== undefined;
          return (
            <li key={`${c.key}-${fileControls}`}>
              {/* The same three characters as the readiness checklist: a tick
                  is a thing settled, a circle a thing not done yet. */}
              <span className={`mark ${stored ? "status-success" : "dim"}`}>{stored ? "✓" : "○"}</span>
              <span className="platform">{c.platform}</span>
              <span className="grow">
                <span className="bright">{c.what}</span> <span className="dim">{c.extension}</span>
                <div className="dim">
                  stored as <code>{c.key}</code>
                  {stored && " — choosing another file replaces it"}
                </div>
              </span>
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
                <span className="accent">{stored ? "replace" : "choose"} →</span>
              </label>
              {/* Removal lives here now, because the listing above no longer
                  shows these — and a credential you cannot delete from the
                  interface is one you have to go to the command line for. */}
              {stored &&
                (storedSecret?.scope === "global" ? (
                  <span className="dim" title="set for every project — laneyard secret set">
                    global
                  </span>
                ) : (
                  <button onClick={() => void remove({ key: c.key } as SecretSummary)} title="remove">
                    ✗
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      <p className="dim">an existing name is replaced.</p>

      {formError && <p className="status-failed">refused — {formError}</p>}
    </>
  );
}

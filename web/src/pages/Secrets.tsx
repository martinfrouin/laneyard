import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { CredentialSummary, EnvFile, SecretSummary } from "../api";
import { NeededByLanes } from "../components/NeededByLanes";

/**
 * The values one project stores, in two zones: variables and secrets.
 *
 * The line between them is not this screen's invention — it is the user's own
 * tick box. `masked` means "keep this out of the build log", and it decides how
 * a value reaches this page rather than whether it may.
 *
 * A variable stored in the clear is printed verbatim in every log its lane
 * produces, so it arrives with the listing and sits on screen: hiding it behind
 * a click protected nothing and cost the one thing this page is for.
 *
 * A secret is never in the listing, and is fetched by name when `show` is
 * pressed. That is the difference worth keeping — opening this tab reveals
 * nothing, and every secret on screen was asked for one at a time — and it is
 * not the same as never being able to look. A passphrase you cannot read is one
 * you can only replace, which is how the wrong value gets stored twice.
 *
 * The `••••••` is the same marker the logs use — what you see beside a secret
 * here is exactly what a run's output would show.
 *
 * Everything on this screen is a value somebody types. The files a lane needs to
 * sign or upload are a different act with a different shape — pick a file, fill
 * the fields it needs, store it whole — and they have their own tab. What is
 * left here is one activity, and the page says so in one line at the top.
 */
export function Secrets() {
  const { slug = "" } = useParams();
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [envFile, setEnvFile] = useState<EnvFile | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Bumped whenever the vault changed, so the needed list can shrink with it. */
  const [stamp, setStamp] = useState(0);

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

    // The file this project writes, if it writes one. Quiet on failure for the
    // same reason as the blocks below: it decorates this page, it is not it.
    api
      .envFile(slug)
      .then(setEnvFile)
      .catch(() => setEnvFile(null));

    // Read, never shown: the blocks live on their own tab now, and the only
    // thing this page has to say about them is which stored rows they overtook.
    // A failure here costs that one sentence and nothing else, so it is quiet.
    api
      .listCredentials(slug)
      .then(setCredentials)
      .catch(() => setCredentials([]));

    setStamp((n) => n + 1);
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

  /**
   * Masked values on screen, one at a time and only once asked for.
   *
   * Kept in a map rather than in the row's own state so that showing one is a
   * deliberate act with a visible opposite: `hide` drops it, and leaving the
   * page drops all of them. Nothing here is ever fetched in bulk — the listing
   * carries no masked value, so every one on screen was pressed for.
   */
  const [shown, setShown] = useState<Record<string, string>>({});

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
   * you were trying to read. Flipping it moves the row between the two zones,
   * which is the whole of what the zones are.
   */
  const toggleMasked = async (secret: SecretSummary) => {
    setFormError(null);
    try {
      await api.setSecretMasked(slug, secret.key, !secret.masked);
      // A value that has just become secret must not stay on screen because it
      // happened to be revealed a moment ago.
      hide(secret.key);
      load();
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  /**
   * Whether this variable is also written into the file the build reads.
   *
   * Flipped here, on the row, rather than picked from a list inside the file's
   * own panel. The choice is made while whoever made it still knows what the
   * variable is for — a picker visited later is where one gets forgotten, and a
   * variable missing from the file is an empty value in a shipped app, with no
   * error anywhere to say so.
   */
  const toggleInEnvFile = async (secret: SecretSummary) => {
    setFormError(null);
    try {
      await api.setSecretInEnvFile(slug, secret.key, !secret.inEnvFile);
      load();
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  /** The path being typed, kept apart from the stored one until it is saved. */
  const [pathDraft, setPathDraft] = useState("");
  useEffect(() => setPathDraft(envFile?.path ?? ""), [envFile?.path]);

  /**
   * Turns the file on, moves it, or turns it off.
   *
   * Writes `config.yml` on the server. A `laneyard.yml` in the repository wins
   * over that file for every setting, so where one names the path this is read
   * only — offering a control whose effect the next run would ignore is worse
   * than saying who decides.
   */
  const fromRepo = envFile?.provenance === "repo";

  const saveEnvFile = async (event: React.FormEvent | null, path?: string | null) => {
    event?.preventDefault();
    setFormError(null);
    const next = path === undefined ? pathDraft : path;
    if (next === envFile?.path) return;
    try {
      await api.setEnvFile(slug, next === null ? null : next.trim());
      load();
    } catch (e) {
      setFormError((e as Error).message);
      setPathDraft(envFile?.path ?? "");
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

  /**
   * What a row is worth now that signing blocks exist, when the answer is not
   * "the same as before".
   *
   * Both names keep working exactly as they did — nothing is removed here, and
   * a build that relies on one is not changed by this sentence. What was
   * missing is that the screen said nothing, so a row made redundant by an
   * upload looked like any other row, and the one row that never did anything
   * looked like a stored credential.
   *
   * Two cases, and they are not the same. `APP_STORE_CONNECT_API_KEY_P8` never
   * worked: no action in fastlane reads that name — this interface invented it
   * and asked people to store their `.p8` under it — so the value is encrypted,
   * listed, and read by nothing. Ours to say plainly rather than leave someone
   * to discover.
   *
   * `SUPPLY_JSON_KEY_DATA` is fastlane's own, and supply reads it. It is
   * superseded only once a Play block applies, and then only because the
   * credential is stored twice with nothing on screen saying which one a build
   * used. Reported as redundant, never as broken.
   */
  const superseded = (s: SecretSummary): string | null => {
    if (s.key === "APP_STORE_CONNECT_API_KEY_P8") {
      return "nothing reads this name.";
    }
    if (
      s.key === "SUPPLY_JSON_KEY_DATA" &&
      credentials.some((c) => c.kind === "play_service_account")
    ) {
      return "stored twice — nothing says which one a build used.";
    }
    return null;
  };

  /**
   * One row, written once for both zones. Two copies of this markup would be
   * two copies that drift, and the difference between the zones is a flag —
   * not a different way of showing a name.
   */
  const row = (s: SecretSummary) => {
    const note = superseded(s);
    // Two ways a value gets on screen and one place they meet: unmasked, it
    // came with the listing; masked, it came from pressing `show`. Below this
    // line the row does not care which.
    const value = s.masked ? shown[s.key] : s.value;
    return (
      <li key={s.key} className={note ? "superseded" : undefined}>
        {/* ✓ kept out of the logs, ○ stored as it is and printed as it is. */}
        <span className={`mark ${s.masked ? "accent" : "dim"}`}>{s.masked ? "✓" : "○"}</span>
        <span className="grow">
          {/* Name and value are two facts, not one phrase, and a single space
              between them made `SENTRY_ORG popotes` read as one string. The
              name gets a column of its own so every value on the screen starts
              at the same place — which is what makes a wrong one stand out. */}
          <span className="pair">
            <span className="bright key">{s.key}</span>
            {value === undefined ? (
              <span className="dim">{s.masked ? "••••••" : "unreadable — store it again"}</span>
            ) : (
              <span className="revealed">{value}</span>
            )}
          </span>
          {/* On its own line, because it is a sentence about the row rather than
              another word about the value — and because nothing else on this
              screen wraps. Never a removal: it is the user's data, and a build
              server that quietly drops a credential is worse than one that
              leaves a redundant row. */}
          {note && <span className="superseded-note">{note}</span>}
        </span>

        {/* A checkbox, not a verb: this is a property of the value, and it is
            the only control on the row that changes what is on screen beside
            it. One word, and the same word the form uses. */}
        <label className="row-flag" title="kept out of the build logs, and never shown here">
          <input type="checkbox" checked={s.masked} onChange={() => void toggleMasked(s)} />
          secret
        </label>

        {/* Only where there is a file to be in. Offering the choice to a project
            that writes none would be a control with nothing behind it. */}
        {envFile?.path && (
          <label className="row-flag" title={`written into ${envFile.path} for the length of a run`}>
            <input type="checkbox" checked={s.inEnvFile} onChange={() => void toggleInEnvFile(s)} />
            in file
          </label>
        )}

        {/* Only on a masked row: an unmasked value is already there, and a
            button that hid it again would be a control whose whole effect is to
            show you less. */}
        {s.masked &&
          (value === undefined ? (
            <button onClick={() => void show(s)} title="show the value">
              show
            </button>
          ) : (
            <button onClick={() => hide(s.key)} title="hide it again">
              hide
            </button>
          ))}

        {/* The word rather than the mark on a superseded row: ✗ is the same
            three pixels everywhere on this page, and the one row worth removing
            should not need the same look as the rows worth keeping. */}
        <button onClick={() => void remove(s)} title={note ? "remove this row" : "remove"}>
          {note ? "remove" : "✗"}
        </button>
      </li>
    );
  };

  const variables = secrets.filter((s) => !s.masked);
  const kept = secrets.filter((s) => s.masked);

  return (
    <>
      {/* No preamble. The two headings, the marks and the `secret` box carry the
          whole distinction, and a paragraph restating them was read once by
          nobody and skipped forever after. What is left on this screen is the
          values themselves and the words that only appear when something is
          wrong — a refusal, a row nothing reads. */}
      <h2 className="section">variables</h2>

      {listError && <p className="status-failed">unreadable secrets — {listError}</p>}
      {loading && <p className="dim">reading vault…</p>}
      {!loading && !listError && variables.length === 0 && (
        <p className="dim">nothing stored in the clear.</p>
      )}
      <ul className="rows">{variables.map(row)}</ul>

      <h2 className="section" style={{ marginTop: 20 }}>
        secrets
      </h2>
      {!loading && !listError && kept.length === 0 && <p className="dim">no secrets yet.</p>}
      <ul className="rows">{kept.map(row)}</ul>

      {/* The file, shown rather than described. A row of tick boxes cannot tell
          you that one is missing; this can, which is the whole reason the choice
          is a box on each row and not a picker in here.

          Shown even when there is no file, and that is not decoration. The path
          is a setting in `laneyard.yml`, so there is nothing here to switch on —
          and a section that appeared only once it was already configured would
          be a feature nobody could find in order to configure it. The empty
          state is the one line to write, which is the whole of what is missing. */}
      <h2 className="section" style={{ marginTop: 20 }}>
        environment file
      </h2>

      <form className="secret-form" onSubmit={(e) => void saveEnvFile(e)}>
        <label className="row-flag">
          <input
            type="checkbox"
            checked={envFile?.path !== null && envFile?.path !== undefined}
            disabled={fromRepo}
            onChange={(e) => void (e.target.checked ? saveEnvFile(null, ".env") : saveEnvFile(null, null))}
          />
          write one
        </label>
        {envFile?.path && (
          <input
            type="text"
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onBlur={() => void saveEnvFile(null, pathDraft)}
            disabled={fromRepo}
            spellCheck={false}
            autoComplete="off"
            aria-label="path"
          />
        )}
        {fromRepo && <span className="dim">set by laneyard.yml</span>}
      </form>

      {envFile?.path &&
        (envFile.body === "" ? (
          <p className="dim">nothing ticked.</p>
        ) : (
          <pre className="env-file-preview">{envFile.body}</pre>
        ))}

      {/* Before the free-form form, because it is the reason most people open
          this page — and because a name that is already on screen is a name
          nobody can mistype. */}
      <NeededByLanes slug={slug} refresh={stamp} onStored={load} />

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
        {/* Plain text, including for something about to be kept out of the
            logs. Masking here protected nothing — the value is on this machine,
            typed by the person who owns it — and cost the one moment when
            seeing it matters: a pasted token with a newline in it, a password
            typed on the wrong keyboard layout, stored and wrong until a build
            fails days later. Hiding starts once the value is stored, and only
            for the values that asked for it. */}
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          spellCheck={false}
          autoComplete="off"
          aria-label="value"
        />
        {/* The same word as the row's own box, and the title says the rest for
            whoever wants it. It used to read "keep this out of the logs", which
            is what the box does rather than what it means. */}
        <label title="kept out of the build logs, and never shown here">
          <input type="checkbox" checked={masked} onChange={(e) => setMasked(e.target.checked)} />
          secret
        </label>
        <button type="submit" disabled={saving || key.trim() === "" || value === ""}>
          store
        </button>
      </form>

      {formError && <p className="status-failed">refused — {formError}</p>}
    </>
  );
}

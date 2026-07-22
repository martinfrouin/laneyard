import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { CredentialSummary, SecretSummary } from "../api";
import { NeededByLanes } from "../components/NeededByLanes";

/**
 * The values one project stores, in two zones: variables and secrets.
 *
 * The line between them is not this screen's invention — it is the user's own
 * tick box. `masked` means "keep this out of the build log", and the vault
 * answers on that basis alone: a value carrying it is never sent back, whoever
 * asks, so those rows offer no `show` and never could. A value without it can be
 * read on request, one named key at a time, which is what makes an imported name
 * something you can check rather than take on faith.
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
   * Values read one at a time, and forgotten as readily.
   *
   * Kept in a map rather than fetched into the row's own state so that showing
   * one is a deliberate act with a visible opposite: `hide` drops it, and
   * leaving the page drops all of them. Nothing here is ever fetched in bulk.
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
      return "nothing reads this. no action in fastlane looks for that name — an earlier version of this interface asked for it, which was our mistake. the .p8 belongs on the signing tab, as an app store connect key block.";
    }
    if (
      s.key === "SUPPLY_JSON_KEY_DATA" &&
      credentials.some((c) => c.kind === "play_service_account")
    ) {
      return "superseded by the play store service account block on the signing tab. this still works — but the same credential is now stored twice, and nothing says which one a build used.";
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
    return (
      <li key={s.key} className={note ? "superseded" : undefined}>
        {/* ✓ kept out of the logs, ○ stored as it is and printed as it is. */}
        <span className={`mark ${s.masked ? "accent" : "dim"}`}>{s.masked ? "✓" : "○"}</span>
        <span className="grow">
          <span className="bright">{s.key}</span>{" "}
          {s.masked ? (
            <span className="dim">••••••</span>
          ) : shown[s.key] !== undefined ? (
            <span className="revealed">{shown[s.key]}</span>
          ) : (
            <span className="dim">stored as it is</span>
          )}
          {/* The one sentence that explains why a row has no `show`. The
              redaction and the reading are the same decision seen from two
              sides — Laneyard treats a secret as one end to end — and a
              missing button with no reason reads as a missing feature. */}
          {s.masked && <span className="dim"> — kept out of the logs, so never shown here either</span>}
          {/* On its own line, because it is a sentence about the row rather than
              another word about the value — and because nothing else on this
              screen wraps. Never a removal: it is the user's data, and a build
              server that quietly drops a credential is worse than one that
              leaves a redundant row. */}
          {note && <span className="superseded-note">{note}</span>}
        </span>

        {/* A checkbox, not a verb. This is a property of the secret, and a
            button beside `show` read as a second way of doing the same
            thing. The wording is the form's own, word for word, so the
            thing you tick when storing is the thing you see afterwards. */}
        {s.scope !== "global" && (
          <label className="row-flag" title="a secret is removed from build logs, and never shown here">
            <input type="checkbox" checked={s.masked} onChange={() => void toggleMasked(s)} />
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
          // The word rather than the mark on a superseded row: ✗ is the same
          // three pixels everywhere on this page, and the one row worth removing
          // should not need the same look as the rows worth keeping.
          <button onClick={() => void remove(s)} title={note ? "remove this row" : "remove"}>
            {note ? "remove" : "✗"}
          </button>
        )}
      </li>
    );
  };

  const variables = secrets.filter((s) => !s.masked);
  const kept = secrets.filter((s) => s.masked);

  return (
    <>
      {/* What this tab is, before the first heading names a half of it: someone
          landing here cold reads one sentence about values, and the two
          headings under it are the one distinction that matters. */}
      <p className="dim">
        the values this project's lanes read. typed here, encrypted at rest, and handed to every run
        as environment variables.
      </p>

      <h2 className="section" style={{ marginTop: 16 }}>
        variables
      </h2>
      <p className="dim">stored as they are — printed in the logs, and readable here on request.</p>

      {listError && <p className="status-failed">unreadable secrets — {listError}</p>}
      {loading && <p className="dim">reading vault…</p>}
      {!loading && !listError && variables.length === 0 && (
        <p className="dim">nothing stored in the clear.</p>
      )}
      <ul className="rows">{variables.map(row)}</ul>

      <h2 className="section" style={{ marginTop: 20 }}>
        secrets
      </h2>
      <p className="dim">
        the same variables, kept out of the build logs — and never sent back, not even to this page.
      </p>
      {!loading && !listError && kept.length === 0 && <p className="dim">no secrets yet.</p>}
      <ul className="rows">{kept.map(row)}</ul>

      {/* One quiet line, where somebody looking for a keystore would look: this
          page held those blocks until now, and a thing that moved must say where
          it went rather than leave an absence to be read as a removal. */}
      <p className="dim" style={{ marginTop: 10 }}>
        a file rather than a value — an app store connect key, a keystore, a play store service
        account — is stored on its own tab.{" "}
        <Link to={`/p/${slug}/signing`} className="accent">
          signing →
        </Link>
      </p>

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

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { CredentialSummary, SecretSummary } from "../api";
import { CredentialCard } from "../components/CredentialCard";
import { CREDENTIAL_KINDS } from "../../../src/credentials/kinds";
import type { CredentialKind, Platform } from "../../../src/credentials/kinds";

/** Fixed, so the two groups keep their order whatever the table is written in. */
const PLATFORMS: Platform[] = ["ios", "android"];

/**
 * What one project stores, in three zones: variables, secrets, signing.
 *
 * The line between the first two is not this screen's invention — it is the
 * user's own tick box. `masked` means "keep this out of the build log", and the
 * vault answers on that basis alone: a value carrying it is never sent back,
 * whoever asks, so those rows offer no `show` and never could. A value without
 * it can be read on request, one named key at a time, which is what makes an
 * imported name something you can check rather than take on faith.
 *
 * The `••••••` is the same marker the logs use — what you see beside a secret
 * here is exactly what a run's output would show.
 *
 * The third zone is for the projects that sign and upload. A project whose
 * lanes take screenshots or run tests needs none of it, and it should cost that
 * project three closed lines — an offer, not a checklist it is failing.
 */
export function Secrets() {
  const { slug = "" } = useParams();
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);
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

    api
      .listCredentials(slug)
      .then((c) => {
        setCredentials(c);
        setBlocksError(null);
      })
      .catch((e: Error) => setBlocksError(e.message));

    // Alongside, not before: a project whose workspace was never cloned still
    // has a secrets page, and this failing must cost the prompt, not the page.
    api
      .requiredSecrets(slug)
      .then((r) => setMissing(r.missing))
      .catch(() => setMissing([]));
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

  /**
   * Which signing blocks are open, which is a fact about this screen and about
   * nothing else. Not stored, not sent anywhere, and gone when the page is:
   * what someone opened to read is not a setting of their project.
   */
  const [opened, setOpened] = useState<CredentialKind[]>([]);
  const toggleBlock = (kind: CredentialKind) =>
    setOpened((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));

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
      return "nothing reads this. no action in fastlane looks for that name — an earlier version of this interface asked for it, which was our mistake. the .p8 belongs under signing, as an app store connect key block.";
    }
    if (
      s.key === "SUPPLY_JSON_KEY_DATA" &&
      credentials.some((c) => c.kind === "play_service_account")
    ) {
      return "superseded by the play store service account block under signing. this still works — but the same credential is now stored twice, and nothing says which one a build used.";
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
      <h2 className="section">variables</h2>
      <p className="dim">
        names every run of this project reads, stored as they are. encrypted at rest, printed in the
        logs, and readable here on request.
      </p>

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

      {/* A credential is a file plus the handful of fields that make it usable,
          and it is worth nothing in pieces: a keystore without its alias is not
          a partial success, it is an artifact rejected by a store days later.
          So one block, taken whole.

          Every kind is offered whether or not this project has any use for it.
          fastlane is not only for shipping — lanes take screenshots, run tests,
          sync certificates — and a project that signs nothing should read three
          quiet lines, not three things it is missing. Which is why they rest
          closed: the zone asks for a glance, and gives back the whole card only
          to somebody who asked for it. */}
      <h2 className="section" style={{ marginTop: 20 }}>
        signing
      </h2>
      <p className="dim">
        only for the lanes that sign and upload. the file stays here, encrypted, and reaches a run as
        a path plus the names each block exports.
      </p>
      {blocksError && <p className="status-failed">unreadable signing blocks — {blocksError}</p>}
      {PLATFORMS.map((platform) => (
        <div key={platform} className="credentials-group">
          {/* The platform is a label on a group, not a question anybody is
              asked: both groups are here whatever this project builds, and an
              android-only project reads one short list instead of skipping
              past an apple block on its way down. */}
          <p className="dim platform">{platform}</p>
          <ul className="rows credentials">
            {CREDENTIAL_KINDS.filter((spec) => spec.platform === platform).map((spec) => (
              <CredentialCard
                key={spec.kind}
                slug={slug}
                spec={spec}
                stored={credentials.find((c) => c.kind === spec.kind)}
                open={opened.includes(spec.kind)}
                onToggle={() => toggleBlock(spec.kind)}
                onChanged={load}
                onError={setFormError}
              />
            ))}
          </ul>
        </div>
      ))}

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

import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * The names this project needs but does not have, each with a field.
 *
 * Its own component because it is its own thing: its own question to the server,
 * its own form, and nothing shared with the two lists it sits under but the slug.
 *
 * The names come from the server; the values never do. Someone arriving here has
 * just been told by the checklist that eight variables are missing, and retyping
 * those eight names correctly is a chore where one typo stores a secret nothing
 * will ever read.
 *
 * It shows nothing at all when nothing is missing — the absence is the good
 * news, and a heading over an empty list would make it read as a section that
 * failed to load.
 */
export function NeededByLanes({
  slug,
  refresh,
  onStored,
}: {
  slug: string;
  /** Bumped by the page when the vault changed under us, so the list can shrink. */
  refresh: number;
  onStored: () => void;
}) {
  const [missing, setMissing] = useState<string[]>([]);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [storing, setStoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A project whose workspace was never cloned still has a secrets page, and
    // this failing must cost the prompt, not the page.
    api
      .requiredSecrets(slug)
      .then((r) => setMissing(r.missing))
      .catch(() => setMissing([]));
  }, [slug, refresh]);

  const store = async (name: string) => {
    const value = (typed[name] ?? "").trim();
    if (value === "") return;
    setStoring(name);
    setError(null);
    try {
      // Masked, like anything typed into this page: a value that turns out not
      // to be secret costs a redacted line in a log, and the reverse costs a leak.
      await api.setSecret(slug, name, value, true);
      setTyped((prev) => ({ ...prev, [name]: "" }));
      onStored();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStoring(null);
    }
  };

  if (missing.length === 0) return null;

  return (
    <>
      <h2 className="section" style={{ marginTop: 20 }}>
        needed by the lanes
      </h2>
      <p className="dim">
        read by a lane, named in <code>.env.example</code>, or listed under{" "}
        <code>required_secrets</code> — and not stored yet. type the value; the name is already the
        one fastlane looks for.
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
                if (e.key === "Enter") void store(name);
              }}
              placeholder="value"
              autoComplete="new-password"
              aria-label={name}
            />
            <button
              onClick={() => void store(name)}
              disabled={storing !== null || (typed[name] ?? "").trim() === ""}
            >
              store
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="status-failed">refused — {error}</p>}
    </>
  );
}

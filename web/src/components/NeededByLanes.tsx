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
  const [fetching, setFetching] = useState(false);
  /** Bumped by the button, so the list is read again after the clone moved. */
  const [fetched, setFetched] = useState(0);

  useEffect(() => {
    // A project whose workspace was never cloned still has a secrets page, and
    // this failing must cost the prompt, not the page.
    api
      .requiredSecrets(slug)
      .then((r) => setMissing(r.missing))
      .catch(() => setMissing([]));
  }, [slug, refresh, fetched]);

  /**
   * The clone, brought up to the remote, and then this list read again.
   *
   * These names are read out of the repository — what a lane fetches from the
   * environment, what a committed `.env.example` declares — and the clone they
   * are read from only ever moved at the start of a run. A Fastfile that stopped
   * reading a variable went on being asked for it for as long as no run got far
   * enough to fetch, with nothing on screen to suggest the answer was old. This
   * is the way to make it current without launching a build.
   */
  const refetch = async () => {
    setFetching(true);
    setError(null);
    try {
      await api.fetchWorkspace(slug);
      setFetched((n) => n + 1);
    } catch (e) {
      // A run in flight, a commit never pushed, a remote that will not answer:
      // the server's sentence is the only thing that says which.
      setError((e as Error).message);
    } finally {
      setFetching(false);
    }
  };

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
      {/* The button sits on the heading because it answers a question about the
          whole list rather than any line of it: not "store this" but "is this
          still true". */}
      <p className="section head-with-action" style={{ marginTop: 20 }}>
        <span>needed by the lanes</span>
        <button onClick={() => void refetch()} disabled={fetching} title="fetch the repository">
          {fetching ? "fetching…" : "refresh"}
        </button>
      </p>
      <ul className="rows needed">
        {missing.map((name) => (
          <li key={name}>
            <span className="mark dim">○</span>
            <span className="needed-name bright">{name}</span>
            {/* Plain text, like the form below this list. What you are doing is
                checking a value into a build server on your own machine — the
                moment it matters that you can see it is exactly this one, with
                a token freshly pasted and a newline you would never notice
                behind dots. Hiding starts once it is stored, and only for the
                values ticked to stay out of the logs. */}
            <input
              type="text"
              className="grow"
              value={typed[name] ?? ""}
              onChange={(e) => setTyped((prev) => ({ ...prev, [name]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void store(name);
              }}
              placeholder="value"
              spellCheck={false}
              autoComplete="off"
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

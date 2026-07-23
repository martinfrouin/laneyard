import { useContext, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { ProjectRemoval } from "../api";
import { ProjectsChanged } from "../App";

/**
 * What a project's settings amount to today: the one way to remove it.
 *
 * Everything else about a project is a file — `laneyard.yml` in the repository,
 * `config.yml` on this machine — and a form that edited a file behind the user's
 * back would be a worse way to change it than an editor. Removal is here
 * because it is the one thing that cannot be done from the interface at all,
 * and hand-editing YAML to make a project disappear is a poor last resort.
 *
 * Removal takes everything Laneyard holds for the project — the config block,
 * the clone, the artifacts, the run history and its logs, and the project's own
 * secrets and signing blocks. The run history is the one thing here nothing can
 * rebuild, so the button is behind the project's name typed back, the way
 * `laneyard uninstall` is behind a typed path: the irreversible thing must not
 * be reachable by a reflex.
 *
 * The screen is honest about its edges. What it does not touch — the git remote,
 * the credential originals, the global secrets every project shares — is said as
 * plainly as what it removes, before the button and again after, so nobody
 * presses this thinking their keystore is gone or leaves thinking a shared
 * secret went with it.
 */
export function Settings() {
  const { slug = "" } = useParams();
  const projectsChanged = useContext(ProjectsChanged);

  const [name, setName] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ProjectRemoval | null>(null);

  /** What this removal will take, counted before anything is touched. */
  const [owned, setOwned] = useState<{ secrets: number; blocks: number } | null>(null);
  const [runs, setRuns] = useState<number | null>(null);

  useEffect(() => {
    setTyped("");
    setError(null);
    setRemoved(null);
    setOwned(null);
    setRuns(null);
    // The name as the sidebar shows it, because that is the word the user will
    // be asked to type. Guessing it from the slug would ask for a string that
    // is not on screen anywhere.
    api
      .projects()
      .then((all) => setName(all.find((p) => p.slug === slug)?.name ?? slug))
      .catch(() => setName(slug));

    // Counted here so the warning below carries numbers rather than "some".
    // Only the rows this project owns: `scope` tells a project secret from a
    // global one it merely reads, and a global one is not this removal's to
    // touch. Failing quietly is right — the counts sharpen the sentences, they
    // are not the sentences, and a page about removal must not refuse to load
    // over them.
    void Promise.all([api.secrets(slug), api.listCredentials(slug)])
      .then(([secrets, credentials]) =>
        setOwned({
          secrets: secrets.filter((s) => s.scope === "project").length,
          blocks: credentials.filter((c) => c.scope === "project").length,
        }),
      )
      .catch(() => setOwned(null));

    void api
      .runsOf(slug)
      .then((r) => setRuns(r.length))
      .catch(() => setRuns(null));
  }, [slug]);

  const remove = async (event: React.FormEvent) => {
    event.preventDefault();
    setRemoving(true);
    setError(null);
    try {
      const result = await api.removeProject(slug);
      setRemoved(result);
      // The sidebar is loaded once, at the top of the app: it has to be told.
      projectsChanged();
    } catch (e) {
      // A run in flight is the expected refusal, and the server's sentence says
      // what to do about it. It is the answer, not a failure to report.
      setError((e as Error).message);
    } finally {
      setRemoving(false);
    }
  };

  if (removed) {
    const r = removed.removed;
    const vaultGone = r.secrets + r.signingBlocks;
    const globalKept = removed.untouched.globalSecrets + removed.untouched.globalSigningBlocks;
    return (
      <>
        <h2 className="section">removed</h2>
        <p>
          <span className="mark accent">✓</span>{" "}
          <span className="bright">{removed.name}</span>{" "}
          <span className="dim">and everything laneyard held for it is gone.</span>
        </p>

        <h2 className="section" style={{ marginTop: 20 }}>
          what was removed
        </h2>
        <ul className="rows consequences">
          <li>
            <span className="mark dim">○</span>
            <span className="grow dim">
              {r.runs === 0 ? (
                "no run history: this project never built anything."
              ) : (
                <>
                  <span className="bright">
                    {r.runs} {r.runs === 1 ? "run" : "runs"}
                  </span>{" "}
                  and everything they produced — their logs and{" "}
                  {r.artifacts === 0
                    ? "no artifacts"
                    : `${r.artifacts} artifact ${r.artifacts === 1 ? "folder" : "folders"}`}{" "}
                  — deleted. this is the part nothing can rebuild.
                </>
              )}
            </span>
          </li>
          <li>
            <span className="mark dim">○</span>
            <span className="grow dim">
              {r.workspace ? (
                <>
                  the <span className="bright">clone</span> is gone from disk.
                </>
              ) : (
                "nothing on disk: this project was never cloned."
              )}
            </span>
          </li>
          <li>
            <span className="mark dim">○</span>
            <span className="grow dim">
              {vaultGone === 0 ? (
                "nothing was in the vault under this name."
              ) : (
                <>
                  <span className="bright">{vaultSentence(r)}</span> forgotten from the vault.
                </>
              )}
            </span>
          </li>
        </ul>

        <h2 className="section" style={{ marginTop: 20 }}>
          what was not touched
        </h2>
        <p className="dim">
          the <span className="bright">git remote</span> is untouched — the repository is on your
          host, not laneyard's. the <span className="bright">credential originals</span> are
          untouched — the <code>.p8</code> and keystore you uploaded are wherever you keep them;
          laneyard removed only its own encrypted copy.
          {globalKept > 0 && (
            <>
              {" "}
              {globalSentence(removed)} shared by every project on this machine,{" "}
              <span className="bright">left alone</span>.
            </>
          )}
        </p>

        <p className="dim" style={{ marginTop: 20 }}>
          <Link to="/" className="accent">
            projects →
          </Link>
        </p>
      </>
    );
  }

  return (
    <div className="danger">
      <h2 className="section">remove this project</h2>

      {/* The one sentence somebody about to press the button needs to have
          read, in the page's brightest text and before anything else. */}
      <p className="irreversible">
        <span className="mark">!</span> this removes everything laneyard holds for{" "}
        <span className="bright">{name ?? slug}</span> and cannot be undone. its run history is the
        one thing nothing can rebuild.
      </p>

      <p className="dim">what removal takes:</p>

      <ul className="rows consequences">
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            its{" "}
            <span className="bright">
              {runs === null
                ? "run history"
                : `${runs} ${runs === 1 ? "run" : "runs"}`}
            </span>{" "}
            — the rows, their logs and their artifacts. removing a project destroys its past here,
            and only here.
          </span>
        </li>
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            the <span className="bright">clone on disk</span>, if it was ever cloned.
          </span>
        </li>
        {/* Counted, not merely mentioned. A signing block cannot be shown by
            anything in here — no route sends one back — so a number is the only
            evidence it exists at all. */}
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            its{" "}
            <span className="bright">
              {owned === null
                ? "secrets and signing blocks"
                : `${owned.secrets} ${owned.secrets === 1 ? "secret" : "secrets"} and ${owned.blocks} ${
                    owned.blocks === 1 ? "signing block" : "signing blocks"
                  }`}
            </span>{" "}
            in the vault — laneyard's own encrypted copies, forgotten. the originals you uploaded
            are untouched.
          </span>
        </li>
      </ul>

      <p className="dim" style={{ marginTop: 16 }}>
        what it does not touch:
      </p>
      <ul className="rows consequences">
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            the <span className="bright">git remote</span> — the repository is on your host and your
            disk. laneyard neither reads nor writes it.
          </span>
        </li>
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            the <span className="bright">credential originals</span> — the <code>.p8</code>, the
            keystore. laneyard removes its copy; you would upload them again from wherever you keep
            them.
          </span>
        </li>
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            any <span className="bright">global secrets and signing blocks</span> — shared by every
            project on this machine, not this one's to take.
          </span>
        </li>
      </ul>

      {/* The one state change removal is refused for, said before it happens
          rather than found later as a refusal for a reason nobody asked for. */}
      <p className="dim" style={{ marginTop: 20 }}>
        a run in flight holds the workspace: removal is refused until it finishes. a queued run will
        not start — it ends as failed, saying its project is gone.
      </p>

      {/* Typing the name is the confirmation. A dialogue one can click through
          is not a confirmation, and this is the one action in the product that
          cannot be undone from the interface. */}
      <form className="confirm-form" onSubmit={(e) => void remove(e)}>
        <label htmlFor="confirm-name" className="dim">
          type <span className="bright">{name ?? slug}</span> to confirm
        </label>
        <input
          id="confirm-name"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" disabled={removing || name === null || typed !== name}>
          remove
        </button>
      </form>

      {error && <p className="status-failed">refused — {error}</p>}
    </div>
  );
}

/**
 * "3 secrets and 1 signing block", with the empty half left out entirely.
 *
 * A project with no block should read "2 secrets", not "2 secrets and 0 signing
 * blocks": a zero in a sentence about what went reads as a warning about
 * nothing.
 */
function vaultSentence(removed: ProjectRemoval["removed"]): string {
  return join([
    plural(removed.secrets, "secret"),
    plural(removed.signingBlocks, "signing block"),
  ]);
}

/** The same, for the global rows this removal was not allowed to touch. */
function globalSentence(removed: ProjectRemoval): string {
  const parts = join([
    plural(removed.untouched.globalSecrets, "global secret"),
    plural(removed.untouched.globalSigningBlocks, "global signing block"),
  ]);
  const one =
    removed.untouched.globalSecrets + removed.untouched.globalSigningBlocks === 1;
  return `${parts} ${one ? "is" : "are"}`;
}

const plural = (n: number, noun: string): string | null =>
  n === 0 ? null : `${n} ${n === 1 ? noun : `${noun}s`}`;

const join = (parts: (string | null)[]): string => parts.filter((p) => p !== null).join(" and ");

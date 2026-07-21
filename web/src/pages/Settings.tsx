import { useContext, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { ProjectRemoval } from "../api";
import { ProjectsChanged } from "../App";

/**
 * What a project's settings amount to today: the one way to stop showing it.
 *
 * Everything else about a project is a file — `laneyard.yml` in the repository,
 * `config.yml` on this machine — and a form that edited a file behind the user's
 * back would be a worse way to change it than an editor. Removal is here
 * because it is the one thing that cannot be done from the interface at all,
 * and hand-editing YAML to make a project disappear is a poor last resort.
 *
 * The screen is mostly a list of things removal does *not* do. That is not
 * padding: "delete" almost everywhere else means the history goes too, and
 * someone who believes that will either not press this, or press it and be
 * surprised — both bad. The runs stay, the files stay, and the paths are named
 * afterwards so they can be removed by hand, once, deliberately.
 */
export function Settings() {
  const { slug = "" } = useParams();
  const projectsChanged = useContext(ProjectsChanged);

  const [name, setName] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ProjectRemoval | null>(null);

  useEffect(() => {
    setTyped("");
    setError(null);
    setRemoved(null);
    // The name as the sidebar shows it, because that is the word the user will
    // be asked to type. Guessing it from the slug would ask for a string that
    // is not on screen anywhere.
    api
      .projects()
      .then((all) => setName(all.find((p) => p.slug === slug)?.name ?? slug))
      .catch(() => setName(slug));
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
    return (
      <>
        <h2 className="section">removed</h2>
        <p>
          <span className="mark accent">✓</span>{" "}
          <span className="bright">{removed.name}</span>{" "}
          <span className="dim">is no longer in this machine's config.yml.</span>
        </p>

        <h2 className="section" style={{ marginTop: 20 }}>
          left behind
        </h2>
        <ul className="rows consequences">
          <li>
            <span className="mark dim">○</span>
            <span className="grow">
              <span className="bright">
                {removed.runsKept} {removed.runsKept === 1 ? "run" : "runs"}
              </span>{" "}
              <span className="dim">
                still in the history, each still at its own address. their logs and artifacts
                download as they always did.
              </span>
            </span>
          </li>
          {removed.leftOnDisk.length === 0 ? (
            <li>
              <span className="mark dim">○</span>
              <span className="grow dim">nothing on disk: this project was never cloned.</span>
            </li>
          ) : (
            removed.leftOnDisk.map((path) => (
              <li key={path}>
                <span className="mark dim">○</span>
                <span className="grow">
                  <span className="path">{path}</span>{" "}
                  <span className="dim">— left where it is. remove it by hand if you want it gone.</span>
                </span>
              </li>
            ))
          )}
        </ul>

        <p className="dim" style={{ marginTop: 20 }}>
          <Link to="/" className="accent">
            projects →
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h2 className="section">remove this project</h2>
      <p className="dim">
        laneyard stops showing <span className="bright">{name ?? slug}</span>: its block leaves this
        machine's config.yml, and nothing else happens. what that does not do:
      </p>

      <ul className="rows consequences">
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            its <span className="bright">runs stay</span> — every build it ever ran keeps its page,
            its log and its artifacts. removing a project means stop showing it, not destroy its
            past.
          </span>
        </li>
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            the <span className="bright">clone and the artifacts stay on disk</span> — their paths
            are shown once it is done, so you can remove them yourself. nothing is deleted from a
            web page on one click.
          </span>
        </li>
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            its <span className="bright">secrets stay in the vault</span>, encrypted and
            unreachable. adding the project back under the same name finds them again.
          </span>
        </li>
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            the <span className="bright">repository is untouched</span> — its laneyard.yml, its
            Fastfile and its history are the repository's, not laneyard's.
          </span>
        </li>
      </ul>

      {/* The one state change removal does cause, said before it happens rather
          than found later as a run that failed for a reason nobody asked for. */}
      <p className="dim" style={{ marginTop: 20 }}>
        a run in flight holds the workspace: removal is refused until it finishes. a run still
        waiting in the queue will not start — it ends as failed, saying its project is gone.
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
    </>
  );
}

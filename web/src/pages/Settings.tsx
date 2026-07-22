import { useContext, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { ProjectRemoval, VaultForgotten } from "../api";
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
 *
 * The vault is the one item on that list that has to be counted rather than
 * merely mentioned. A clone can be looked at; a run has a page; a signing block
 * has neither — no route ever sends one back — so a keystore left under a slug
 * nobody uses is invisible unless this screen says how many there are. And it
 * would not stay harmlessly invisible: the scope is the slug, so setting a
 * project up again under the same name silently re-attaches it. Hence the
 * second action below the result, which is the only way to remove them and is
 * never part of removing the project.
 */
export function Settings() {
  const { slug = "" } = useParams();
  const projectsChanged = useContext(ProjectsChanged);

  const [name, setName] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ProjectRemoval | null>(null);

  /** What the vault holds under this slug, before anything is removed. */
  const [owned, setOwned] = useState<{ secrets: number; blocks: number } | null>(null);
  const [typedVault, setTypedVault] = useState("");
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState<VaultForgotten | null>(null);

  useEffect(() => {
    setTyped("");
    setError(null);
    setRemoved(null);
    setTypedVault("");
    setForgetError(null);
    setForgotten(null);
    setOwned(null);
    // The name as the sidebar shows it, because that is the word the user will
    // be asked to type. Guessing it from the slug would ask for a string that
    // is not on screen anywhere.
    api
      .projects()
      .then((all) => setName(all.find((p) => p.slug === slug)?.name ?? slug))
      .catch(() => setName(slug));

    // Counted here so the warning below carries a number rather than "some".
    // Only the rows this project owns: `scope` tells a project secret from a
    // global one it merely reads, and a global one is not this page's to touch.
    // Failing quietly is right — the count sharpens the sentence, it is not the
    // sentence, and a page about removal must not refuse to load over it.
    void Promise.all([api.secrets(slug), api.listCredentials(slug)])
      .then(([secrets, credentials]) =>
        setOwned({
          secrets: secrets.filter((s) => s.scope === "project").length,
          blocks: credentials.filter((c) => c.scope === "project").length,
        }),
      )
      .catch(() => setOwned(null));
  }, [slug]);

  const forgetVault = async (event: React.FormEvent) => {
    event.preventDefault();
    setForgetting(true);
    setForgetError(null);
    try {
      setForgotten(await api.forgetProjectVault(slug));
    } catch (e) {
      setForgetError((e as Error).message);
    } finally {
      setForgetting(false);
    }
  };

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

  const vaultKept = removed ? removed.vaultKept.secrets + removed.vaultKept.signingBlocks : 0;

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
          {/* Last in the list and the only one with an action under it, because
              it is the only one you cannot go and look at. */}
          <li>
            <span className="mark dim">○</span>
            <span className="grow">
              {vaultKept === 0 ? (
                <span className="dim">nothing in the vault under this name.</span>
              ) : (
                <>
                  <span className="bright">{vaultSentence(removed)}</span>{" "}
                  <span className="dim">
                    still in the vault under <span className="path">{removed.slug}</span>, encrypted.
                    a project set up again under that name finds them, and would sign with them.
                  </span>
                </>
              )}
            </span>
          </li>
        </ul>

        {vaultKept > 0 && !forgotten && (
          <>
            <h2 className="section" style={{ marginTop: 20 }}>
              the vault
            </h2>
            <p className="irreversible">
              <span className="mark">!</span> a signing block cannot be read back out of laneyard.
              the <code>.p8</code> and the keystore you uploaded are the only copies it ever had —
              removing them here means uploading them again from wherever you keep them.
            </p>
            <p className="dim">
              {removed.vaultKept.globalSecrets + removed.vaultKept.globalSigningBlocks > 0 && (
                <>
                  {globalSentence(removed)} shared by every project on this machine —{" "}
                  <span className="bright">not touched</span> by this.{" "}
                </>
              )}
              keeping them is fine: they cost nothing and stay unreadable. this is here so the
              choice is yours rather than nobody's.
            </p>

            <form className="confirm-form" onSubmit={(e) => void forgetVault(e)}>
              <label htmlFor="confirm-vault" className="dim">
                type <span className="bright">{removed.name}</span> again to remove them
              </label>
              <input
                id="confirm-vault"
                type="text"
                value={typedVault}
                onChange={(e) => setTypedVault(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" disabled={forgetting || typedVault !== removed.name}>
                remove from vault
              </button>
            </form>
            {forgetError && <p className="status-failed">refused — {forgetError}</p>}
          </>
        )}

        {forgotten && (
          <p style={{ marginTop: 20 }}>
            <span className="mark accent">✓</span>{" "}
            <span className="dim">
              removed {forgotten.secretsRemoved}{" "}
              {forgotten.secretsRemoved === 1 ? "secret" : "secrets"} and{" "}
              {forgotten.signingBlocksRemoved}{" "}
              {forgotten.signingBlocksRemoved === 1 ? "signing block" : "signing blocks"} from the
              vault. global ones were left alone.
            </span>
          </p>
        )}

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
          read, in the page's brightest text and before the reassurances. The
          list below is all about what removal spares — true, and exactly the
          sort of thing that reads as "this is safe" if it comes first. */}
      <p className="irreversible">
        <span className="mark">!</span> this cannot be undone from laneyard. adding{" "}
        <span className="bright">{name ?? slug}</span> back means setting it up again.
      </p>

      <p className="dim">
        laneyard stops showing it: its block leaves this machine's config.yml, and nothing else
        happens. what that does not do:
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
        {/* Counted, not merely mentioned. Everything else on this list can be
            gone and looked at; a signing block cannot be shown by anything in
            here, so a number is the only evidence it exists at all. */}
        <li>
          <span className="mark dim">○</span>
          <span className="grow dim">
            its{" "}
            <span className="bright">
              {owned === null
                ? "secrets and signing blocks stay in the vault"
                : `${owned.secrets} ${owned.secrets === 1 ? "secret" : "secrets"} and ${owned.blocks} ${
                    owned.blocks === 1 ? "signing block" : "signing blocks"
                  } stay in the vault`}
            </span>
            , encrypted. setting a project up again under the name{" "}
            <span className="path">{slug}</span> finds them, and it would sign with them without
            anyone uploading anything. you are offered a way to remove them once this is done.
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
    </div>
  );
}

/**
 * "3 secrets and 1 signing block", with the empty half left out entirely.
 *
 * A project with no block should read "2 secrets", not "2 secrets and 0 signing
 * blocks": a zero in a sentence about what was left behind reads as a warning
 * about nothing.
 */
function vaultSentence(removed: ProjectRemoval): string {
  return join([
    plural(removed.vaultKept.secrets, "secret"),
    plural(removed.vaultKept.signingBlocks, "signing block"),
  ]);
}

/** The same, for the global rows this removal is not allowed to touch. */
function globalSentence(removed: ProjectRemoval): string {
  const parts = join([
    plural(removed.vaultKept.globalSecrets, "global secret"),
    plural(removed.vaultKept.globalSigningBlocks, "global signing block"),
  ]);
  const one =
    removed.vaultKept.globalSecrets + removed.vaultKept.globalSigningBlocks === 1;
  return `${parts} ${one ? "is" : "are"}`;
}

const plural = (n: number, noun: string): string | null =>
  n === 0 ? null : `${n} ${n === 1 ? noun : `${noun}s`}`;

const join = (parts: (string | null)[]): string => parts.filter((p) => p !== null).join(" and ");

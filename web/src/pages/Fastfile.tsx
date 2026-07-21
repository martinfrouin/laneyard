import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { Changes } from "../api";

/**
 * CodeMirror is three times the weight of the rest of the interface, and three
 * of the four tabs have no use for it. It is split into its own chunk so those
 * three keep loading what they did before.
 *
 * Still bundled, never fetched from a CDN: the chunk is served by Laneyard
 * itself, from the same directory as everything else, so a build machine with
 * no route to the internet loads this screen exactly like the others.
 */
const Editor = lazy(() => import("../components/Editor").then((m) => ({ default: m.Editor })));

/**
 * One line of a unified diff, coloured by what it does.
 *
 * `+` green and `-` red are the two colours that already mean success and
 * failure here. A diff is the one place where reading them as added and removed
 * is universal, so the exception is worth making rather than inventing a third
 * palette nobody knows.
 */
function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "dim";
  if (line.startsWith("@@")) return "dim";
  if (line.startsWith("+")) return "status-success";
  if (line.startsWith("-")) return "status-failed";
  return "";
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="diff panel">
      {text.split("\n").map((line, i) => (
        <div key={i} className={diffClass(line)}>
          {line === "" ? " " : line}
        </div>
      ))}
    </pre>
  );
}

/**
 * The Fastfile of one project, as text, with git underneath it.
 *
 * This is a text editor and says so: it hands you the file, not a form over it.
 * Saving is explicit — never on a keystroke — because every write is verified
 * by asking fastlane to parse the file, and that is a subprocess, not a
 * validation regex. It is also the file a run reads: the server refuses to
 * write while a run of this project is in flight, and that refusal arrives here
 * as the sentence it is.
 *
 * When verification fails the message goes *above* the editor and the content
 * stays in the box. The file on disk is already back to what it was — the
 * server put it back — so the only copy of the user's work is the one on
 * screen, and throwing it away would be the worst thing this screen could do.
 */
export function Fastfile() {
  const { slug = "" } = useParams();

  // What the editor was opened with — set only from a read of the server's
  // copy, and null while there is nothing to open.
  const [loaded, setLoaded] = useState<string | null>(null);
  // What "unchanged" means right now. It follows a successful save, whereas
  // `loaded` does not: the document must not be rebuilt underneath the cursor.
  const [baseline, setBaseline] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const read = useRef<(() => string) | null>(null);

  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [changes, setChanges] = useState<Changes | null>(null);
  const [message, setMessage] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitNote, setGitNote] = useState<string | null>(null);
  // A commit made from this screen is the one thing we know is waiting to go
  // out: nothing in the API reports how far ahead of the remote the branch is,
  // so `push` appears when there is something we have just created, and not as
  // a button that is always there and usually does nothing.
  const [committed, setCommitted] = useState(false);

  const loadChanges = () => {
    api
      .changes(slug)
      .then(setChanges)
      .catch((e: Error) => setGitError(e.message));
  };

  useEffect(() => {
    setLoaded(null);
    setLoadError(null);
    setEdited(false);
    setSaveError(null);
    setSavedAt(null);
    setCommitted(false);
    setMessage("");
    api
      .fastfile(slug)
      .then((f) => {
        setLoaded(f.content);
        setBaseline(f.content);
      })
      .catch((e: Error) => setLoadError(e.message));
    loadChanges();
  }, [slug]);

  const save = async () => {
    const content = read.current?.();
    if (content === undefined) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveFastfile(slug, content);
      // Only now does the baseline move: until the server has both written and
      // verified, what is on screen is not what is on disk.
      setBaseline(content);
      setEdited(false);
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
      loadChanges();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const commit = async () => {
    setGitBusy(true);
    setGitError(null);
    setGitNote(null);
    try {
      await api.commit(slug, message.trim());
      setMessage("");
      setCommitted(true);
      setGitNote("committed.");
      loadChanges();
    } catch (e) {
      setGitError((e as Error).message);
    } finally {
      setGitBusy(false);
    }
  };

  const push = async () => {
    setGitBusy(true);
    setGitError(null);
    setGitNote(null);
    try {
      await api.push(slug);
      setCommitted(false);
      setGitNote("pushed.");
    } catch (e) {
      setGitError((e as Error).message);
    } finally {
      setGitBusy(false);
    }
  };

  return (
    <>
      <h2 className="section">fastfile</h2>
      <p className="dim">
        the file every run of this project builds from. this is a text editor — saving is explicit,
        and the server parses what you send before it counts.
      </p>

      {loadError && <p className="status-failed">unreadable fastfile — {loadError}</p>}

      <p className="dim editor-bar">
        <span className="grow">
          {loaded === null && !loadError && "reading repository…"}
          {loaded !== null && edited && "unsaved changes"}
          {loaded !== null && !edited && savedAt && `saved at ${savedAt}`}
          {loaded !== null && !edited && !savedAt && "unchanged"}
        </span>
        <button onClick={() => void save()} disabled={saving || !edited} title="write and verify">
          {saving ? "verifying…" : "save"}
        </button>
      </p>

      {/* Above the editor, and saying plainly that nothing was lost: someone who
          has just read "failed" needs to know where their file is before they
          need to know why. */}
      {saveError && (
        <p className="status-failed save-error">
          not saved — {saveError}
          <br />
          <span className="dim">
            the file on disk is unchanged, and your edits are still in the box below.
          </span>
        </p>
      )}

      {loaded !== null && (
        <Suspense fallback={<div className="editor panel" />}>
          <Editor
            initial={loaded}
            baseline={baseline}
            read={read}
            onChange={setEdited}
            onSave={() => void save()}
          />
        </Suspense>
      )}

      <h2 className="section" style={{ marginTop: 20 }}>
        changes
      </h2>

      {changes === null && <p className="dim">reading git…</p>}
      {changes !== null && changes.files.length === 0 && (
        <p className="dim">nothing uncommitted in this workspace.</p>
      )}

      {changes !== null && changes.files.length > 0 && (
        <>
          <ul className="rows">
            {changes.files.map((f) => (
              <li key={f}>
                <span className="mark status-running">▸</span>
                <span className="grow">{f}</span>
              </li>
            ))}
          </ul>
          <Diff text={changes.diff} />
        </>
      )}

      <p className="dim commit-bar">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="commit message"
          spellCheck={false}
          autoComplete="off"
          aria-label="commit message"
        />
        <button
          onClick={() => void commit()}
          disabled={gitBusy || message.trim() === "" || (changes?.files.length ?? 0) === 0}
        >
          commit
        </button>
        {/* Only what changed is staged, never `git add -A`: a build leaves files
            scattered in the workspace and none of them belong in this commit. */}
        {committed && (
          <button onClick={() => void push()} disabled={gitBusy}>
            push
          </button>
        )}
      </p>

      {gitNote && <p className="dim">{gitNote}</p>}
      {gitError && <p className="status-failed">refused — {gitError}</p>}
    </>
  );
}

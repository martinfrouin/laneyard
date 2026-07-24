import { useState } from "react";
import { api } from "../api";
import type { CredentialSummary } from "../api";
import type { KindSpec } from "../../../src/credentials/kinds";

/**
 * One signing block: the file, the fields that make it usable, and the names it
 * reaches the lanes under.
 *
 * A stored block is a summary and nothing else. The server never sends a field
 * value back — not a keystore password, not an issuer id — so there is nothing
 * here to uncover and no button pretending there is. Replacing means giving the
 * block again in full, which is the honest consequence: the server takes a
 * block whole or refuses it, because a keystore stored without its alias is not
 * a partial success, it is a build that fails in a month.
 *
 * It rests closed. Three blocks laid open — a file picker, five fields and four
 * editable names apiece — was most of the screen given to the part most people
 * never touch. Closed, a block is one line that still answers the only question
 * worth asking from across the room: is the credential in place, and which file
 * is it. Opening one is a click, and where it is open lives here, in the page,
 * for as long as the page does — never stored, because which block someone had
 * open ten minutes ago is not a fact about their project.
 */

/**
 * What each exported name stands for. `path` is the file itself and belongs to
 * no field; the rest borrow the label the field already carries, so the two
 * halves of a block never call the same thing by two names.
 */
const slotLabel = (spec: KindSpec, slot: string): string =>
  slot === "path" ? "the file" : (spec.fields.find((f) => f.name === slot)?.label ?? slot);

/**
 * A keystore is bytes, and the route takes base64. Chunk-free because the files
 * this accepts are kilobytes: a `.p8`, a service account JSON, a `.jks`.
 */
const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export function CredentialCard({
  slug,
  spec,
  stored,
  open,
  onToggle,
  onChanged,
  onError,
}: {
  slug: string;
  spec: KindSpec;
  stored: CredentialSummary | undefined;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  // Bumping this remounts the file control, which is the only way to empty one:
  // a control still holding a file would not fire again for that same file, and
  // picking it twice must work.
  const [fileControls, setFileControls] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);

  /**
   * The names this block will export: what Laneyard proposes, then what was
   * stored, then what is being typed. Layered rather than seeded into state
   * because the listing arrives after the first render — a copy taken at mount
   * would show the defaults for a block that has been renamed for months.
   */
  const varNames = { ...spec.defaults, ...(stored?.varNames ?? {}), ...renamed };

  const composing = stored === undefined || replacing;
  // Optional fields are the ones Laneyard asks about and does not insist on —
  // where a gradle properties file goes, and what its keys are called. Leaving
  // one empty is an answer, not an omission.
  const complete = spec.fields.every((f) => f.optional || (fields[f.name] ?? "").trim() !== "");

  /**
   * What a field holds: what Laneyard proposes, then what is being typed. The
   * same layering as the variable names above, and for the same reason — a
   * suggestion is an answer to correct, not a blank to fill in.
   */
  const valueOf = (f: (typeof spec.fields)[number]): string => fields[f.name] ?? f.suggested ?? "";

  const forgetFile = () => {
    setFile(null);
    setFileControls((n) => n + 1);
  };

  const store = async () => {
    if (file === null) return;
    setSaving(true);
    onError(null);
    try {
      await api.putCredential(slug, spec.kind, {
        fileName: file.name,
        fileBase64: base64(new Uint8Array(await file.arrayBuffer())),
        // Read back through `valueOf` so a suggestion left as it stands is
        // stored as the answer it was shown as, rather than as nothing.
        fields: Object.fromEntries(spec.fields.map((f) => [f.name, valueOf(f)])),
        varNames,
      });
      // The values leave the fields as soon as the block is stored: nothing to
      // read over a shoulder, and nothing this page could be asked to show.
      forgetFile();
      setFields({});
      setRenamed({});
      setReplacing(false);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    onError(null);
    try {
      await api.deleteCredential(slug, spec.kind);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <li>
      {/* The one line that is always on screen. The same three characters as the
          readiness checklist — a tick is a thing settled, a circle a thing not
          done, never a thing missing — and then the fact somebody scanning this
          screen came for: the file that is in place, or that none is. The whole
          line is the control, because a line that says something and a separate
          thing to press would be two places for one idea. */}
      <button type="button" className="block-head" onClick={onToggle} aria-expanded={open}>
        <span className={`mark ${stored ? "status-success" : "dim"}`}>{stored ? "✓" : "○"}</span>
        <span className="grow">
          <span className="bright">{spec.what}</span>{" "}
          <span className="dim">
            {stored ? stored.fileName : "nothing stored"}
          </span>
        </span>
        {/* A word rather than a wedge: everything else on this screen says what
            it does, and the one thing that opens the rest should not be the
            exception. */}
        <span className="dim">{open ? "close" : stored ? "open" : "add"}</span>
      </button>

      <div className="block-body" hidden={!open}>
        {stored && !composing && (
          <>
            {/* The block's own fields, not the settings beside them: an
                optional one may never have been answered, and "stored" would be
                claiming something about a field nobody filled in. */}
            {spec.fields.some((f) => !f.optional) && (
              <div className="dim">
                {/* `••••••` is the marker the logs use, and it means the same
                    thing here: this value left the browser and does not come
                    back. A field that is not secret is no more readable — the
                    block is stored as one, encrypted whole. */}
                {spec.fields
                  .filter((f) => !f.optional)
                  .map((f) => `${f.label} ${f.secret ? "••••••" : "stored"}`)
                  .join(" · ")}
              </div>
            )}
            <div className="dim">
              exported as{" "}
              {Object.entries(varNames).map(([slot, name], i) => (
                <span key={slot}>
                  {i > 0 && ", "}
                  <code>{name}</code>
                </span>
              ))}
            </div>
          </>
        )}

        {composing && (
          <>
            <div className="secret-form">
              {file === null ? (
                <>
                  <label className="file-pick">
                    <input
                      key={fileControls}
                      type="file"
                      accept={spec.accept}
                      onChange={(e) => {
                        const chosen = e.target.files?.[0] ?? null;
                        if (chosen === null) return;
                        setFile(chosen);
                        onError(null);
                      }}
                    />
                    <span className="accent">{stored ? "another file" : "choose a file"} →</span>
                  </label>
                  {/* What the picker will accept, beside the picker itself —
                      it belongs to the act of choosing, not to the line that
                      reports what is stored. */}
                  <span className="dim">{spec.accept}</span>
                </>
              ) : (
                // The file's name, never a preview of what is in it. Same line
                // grammar as everything else here: marker, name, dim note, ✗.
                <span className="file-chosen">
                  <span className="mark accent">✓</span> <span className="bright">{file.name}</span>{" "}
                  <span className="dim">read when you store it</span>{" "}
                  <button type="button" onClick={forgetFile} title="choose another file">
                    ✗
                  </button>
                </span>
              )}

              {spec.fields.map((f) => (
                <input
                  key={f.name}
                  type={f.secret ? "password" : "text"}
                  value={valueOf(f)}
                  onChange={(e) => setFields((prev) => ({ ...prev, [f.name]: e.target.value }))}
                  placeholder={f.label}
                  aria-label={f.label}
                  autoComplete={f.secret ? "new-password" : "off"}
                  spellCheck={false}
                />
              ))}
            </div>

            {/* Answers, not homework. These are the names fastlane itself reads,
                already filled in — the question is only whether this repository
                agrees. A Fastfile that reads `ASC_KEY_FILEPATH`, a private name
                fastlane knows nothing about, is not wrong; it says so here
                rather than being asked to rename anything. */}
            <div className="dim">reaches the lanes as — change one if your Fastfile reads another name</div>
            <div className="secret-form">
              {Object.keys(spec.defaults).map((slot) => (
                <label key={slot}>
                  {slotLabel(spec, slot)}
                  <input
                    type="text"
                    style={{ width: "42ch" }}
                    value={varNames[slot] ?? ""}
                    onChange={(e) => setRenamed((prev) => ({ ...prev, [slot]: e.target.value }))}
                    aria-label={`${slotLabel(spec, slot)} variable name`}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
              ))}
              <button onClick={() => void store()} disabled={saving || file === null || !complete}>
                store
              </button>
              {stored && (
                <button type="button" onClick={() => setReplacing(false)}>
                  cancel
                </button>
              )}
            </div>
          </>
        )}

        {stored && !composing && (
          <div className="secret-form">
            <button type="button" onClick={() => setReplacing(true)} title="upload it again">
              replace
            </button>
            {/* The word, not the mark: ✗ belongs at the end of a row, and this
                sits inside an opened block beside another verb. */}
            <button onClick={() => void remove()} title="remove this block">
              remove
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

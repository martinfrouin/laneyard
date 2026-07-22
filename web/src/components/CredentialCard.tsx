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
  onChanged,
  onError,
}: {
  slug: string;
  spec: KindSpec;
  stored: CredentialSummary | undefined;
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
  const complete = spec.fields.every((f) => (fields[f.name] ?? "").trim() !== "");

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
        fields,
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
      {/* The same three characters as the readiness checklist: a tick is a thing
          settled, a circle a thing not done — never a thing missing. */}
      <span className={`mark ${stored ? "status-success" : "dim"}`}>{stored ? "✓" : "○"}</span>
      <span className="grow">
        <span className="bright">{spec.what}</span> <span className="dim">{spec.accept}</span>

        {stored && (
          <div className="dim">
            {stored.fileName}
            {stored.scope === "global" && " — set for every project"}
          </div>
        )}

        {stored && !composing && (
          <>
            {spec.fields.length > 0 && (
              <div className="dim">
                {/* `••••••` is the marker the logs use, and it means the same
                    thing here: this value left the browser and does not come
                    back. A field that is not secret is no more readable — the
                    block is stored as one, encrypted whole. */}
                {spec.fields.map((f) => `${f.label} ${f.secret ? "••••••" : "stored"}`).join(" · ")}
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
                  value={fields[f.name] ?? ""}
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
      </span>

      {stored && !composing && (
        <button type="button" onClick={() => setReplacing(true)} title="upload it again">
          replace
        </button>
      )}
      {stored &&
        (stored.scope === "global" ? (
          // A global block belongs to every project. Replacing it from here
          // stores this project's own, which is an override and reads as one;
          // deleting it from here would be a deletion for everybody.
          <span className="dim" title="set for every project, so not removed from inside one">
            global
          </span>
        ) : (
          <button onClick={() => void remove()} title="remove">
            ✗
          </button>
        ))}
    </li>
  );
}

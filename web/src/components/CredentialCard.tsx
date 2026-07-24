import { useState } from "react";
import { api } from "../api";
import type { CredentialSummary } from "../api";
import type { KindSpec } from "../../../src/credentials/kinds";

/**
 * One signing block: the file, the fields that make it usable, and the names it
 * reaches the lanes under.
 *
 * A stored block shows what was typed. It used to show the word `stored` for
 * every field, which is the same word for a right alias and one missing a
 * character — and a keystore password one character short is a build that fails
 * an hour later with `keystore password was incorrect`, when the one screen
 * that could have shown the mistake was claiming everything was in place. So
 * the fields that are not secret come with the listing, and a password comes
 * one at a time on `show`, exactly as on the secrets screen.
 *
 * And it is corrected a piece at a time. A block arriving is still taken whole
 * — a keystore stored without its alias is not a partial success, it is a build
 * that fails in a month — but once it is in place, a field, a name, or the file
 * changes on its own. The alternative was uploading a `.jks` again to fix one
 * character of a password: asking for the part nobody doubted, and one more
 * chance to mistype the part that was wrong.
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

/**
 * Two paths that mean the same file. Compared as text, which is all a browser
 * can do — `./android/key.properties` is the same answer as
 * `android/key.properties`, typed by someone being careful.
 */
const samePath = (a: string, b: string): boolean => {
  const clean = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
  return clean(a) === clean(b);
};

export function CredentialCard({
  slug,
  spec,
  stored,
  propertiesPath,
  open,
  onToggle,
  onChanged,
  onError,
}: {
  slug: string;
  spec: KindSpec;
  stored: CredentialSummary | undefined;
  /** Where this project's build reads the properties file, or null if unknown. */
  propertiesPath?: string | null;
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
   * Secret fields on screen, one at a time and only once asked for. Kept here
   * for as long as the page lives and no longer — which block someone read a
   * password out of ten minutes ago is not a fact about their project.
   */
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  /** Values put away again by hand — the other half of `show`, for any field. */
  const [concealed, setConcealed] = useState<Set<string>>(new Set());
  /** The one field being corrected, and what is being typed into it. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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
  /**
   * What Laneyard proposes for a field: the kind's own suggestion, and for the
   * properties path the place this project's build actually reads. Read from
   * the clone rather than guessed, and offered rather than imposed — a field
   * nobody can fill in from memory is a field that gets filled in wrong.
   */
  const suggestionFor = (f: (typeof spec.fields)[number]): string | undefined =>
    f.name === "properties_path" ? (propertiesPath ?? undefined) : f.suggested;

  const valueOf = (f: (typeof spec.fields)[number]): string =>
    fields[f.name] ?? suggestionFor(f) ?? "";

  /**
   * A stored path that is not where the build reads.
   *
   * The setting wins outright at run time — it exists because detection cannot
   * always tell — so a path off by a directory is written, found by nobody, and
   * the release build signs with the debug key without failing. Said here, where
   * it was typed, and said rather than refused: the reading can be wrong too.
   */
  const wrongPath =
    propertiesPath && (stored?.fields?.["properties_path"] ?? "") !== ""
      ? !samePath(stored!.fields["properties_path"]!, propertiesPath)
      : false;

  const forgetFile = () => {
    setFile(null);
    setFileControls((n) => n + 1);
  };

  /**
   * Puts a value on screen. A secret one is fetched, one field at a time and
   * only because this was pressed; any other is already in the listing and only
   * has to stop being hidden.
   */
  const show = async (f: (typeof spec.fields)[number]) => {
    onError(null);
    setConcealed((prev) => {
      const next = new Set(prev);
      next.delete(f.name);
      return next;
    });
    if (!f.secret || revealed[f.name] !== undefined) return;
    try {
      const { value } = await api.revealCredentialField(slug, spec.kind, f.name);
      setRevealed((prev) => ({ ...prev, [f.name]: value }));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  /** Puts one back away. The value is dropped, not merely covered. */
  const conceal = (field: string) => {
    setConcealed((prev) => new Set(prev).add(field));
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  /**
   * Corrects one field, the file untouched.
   *
   * A block is given whole the first time and corrected a field at a time
   * afterwards, because the alternative — re-uploading the `.jks` to fix a
   * password — is asking for the part nobody doubted and offering another
   * chance to mistype the part that was wrong.
   */
  const save = async (field: string, secret: boolean) => {
    setSaving(true);
    onError(null);
    try {
      await api.patchCredential(slug, spec.kind, { fields: { [field]: draft } });
      // What was just typed stays on screen: the point of correcting a password
      // is seeing that it is now right, and hiding it again on save would send
      // you straight back to `show`.
      if (secret) setRevealed((prev) => ({ ...prev, [field]: draft }));
      setEditing(null);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** One exported name, corrected the same way. */
  const saveName = async (slot: string) => {
    setSaving(true);
    onError(null);
    try {
      await api.patchCredential(slug, spec.kind, { varNames: { [slot]: draft } });
      setEditing(null);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Opens a field for correction, holding what is there now.
   *
   * A secret has to be fetched first: editing is where a password suspected of
   * a typo gets looked at, and starting from an empty box would mean retyping
   * from memory the thing you came to check.
   */
  const startEdit = async (f: (typeof spec.fields)[number]) => {
    onError(null);
    // A field put away by hand comes back out when it is opened for correction:
    // what is in the box is the value, and `••••••` beside it would be a lie.
    setConcealed((prev) => {
      const next = new Set(prev);
      next.delete(f.name);
      return next;
    });
    let current = f.secret ? revealed[f.name] : (stored?.fields?.[f.name] ?? "");
    if (f.secret && current === undefined) {
      try {
        current = (await api.revealCredentialField(slug, spec.kind, f.name)).value;
        setRevealed((prev) => ({ ...prev, [f.name]: current! }));
      } catch (e) {
        onError((e as Error).message);
        return;
      }
    }
    setDraft(current ?? "");
    setEditing(`field:${f.name}`);
  };

  /**
   * The file, on its own or with the block around it.
   *
   * A block arriving for the first time is taken whole — a keystore with no
   * alias is not a partial success. A block already stored gets its file
   * replaced and keeps everything else: a `.p8` is rotated far more often than
   * the key id and issuer id beside it, and making someone retype those to
   * upload a new file is asking for three chances to get one thing wrong.
   */
  const store = async () => {
    if (file === null) return;
    setSaving(true);
    onError(null);
    try {
      const fileName = file.name;
      const fileBase64 = base64(new Uint8Array(await file.arrayBuffer()));
      if (stored) {
        await api.patchCredential(slug, spec.kind, { fileName, fileBase64 });
      } else {
        await api.putCredential(slug, spec.kind, {
          fileName,
          fileBase64,
          // Read back through `valueOf` so a suggestion left as it stands is
          // stored as the answer it was shown as, rather than as nothing.
          fields: Object.fromEntries(spec.fields.map((f) => [f.name, valueOf(f)])),
          varNames,
        });
      }
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
            {/* Every field the kind declares, answered or not: an unanswered
                optional one is where its `edit` lives, and a block whose
                settings can only be reached by uploading the file again is a
                block whose settings nobody corrects. */}
            <ul className="field-list">
              {spec.fields.map((f) => {
                const stashed = f.secret ? revealed[f.name] : stored.fields?.[f.name];
                // Three ways a value gets on screen and one place they meet: a
                // secret came from pressing `show`, another came with the
                // listing, and either can be put away again. Below this line the
                // row does not care which.
                const value = concealed.has(f.name) ? undefined : stashed;
                const answered = f.secret || (stored.fields?.[f.name] ?? "") !== "";
                return (
                  <li key={f.name}>
                    <span className="pair">
                      <span className="dim key">{f.label}</span>
                      {editing === `field:${f.name}` ? (
                        <input
                          autoFocus
                          type="text"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void save(f.name, f.secret)}
                          aria-label={f.label}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      ) : !answered ? (
                        <span className="dim">not set</span>
                      ) : value === undefined ? (
                        // The marker the logs use, meaning the same thing here:
                        // a value that is not on this screen until asked for.
                        <span className="dim">••••••</span>
                      ) : (
                        <span className="revealed">{value}</span>
                      )}
                    </span>

                    {editing === `field:${f.name}` ? (
                      <>
                        <button type="button" disabled={saving} onClick={() => void save(f.name, f.secret)}>
                          save
                        </button>
                        <button type="button" onClick={() => setEditing(null)}>
                          cancel
                        </button>
                      </>
                    ) : (
                      <>
                        {answered &&
                          (value === undefined ? (
                            <button type="button" onClick={() => void show(f)} title="show the value">
                              show
                            </button>
                          ) : (
                            <button type="button" onClick={() => conceal(f.name)}>
                              hide
                            </button>
                          ))}
                        <button
                          type="button"
                          onClick={() => void startEdit(f)}
                          title="change this one, the file untouched"
                        >
                          edit
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* The one thing this screen knows that the person typing did not:
                the file goes where the block says, and the build reads where the
                build reads. Amber rather than red — the reading can be wrong
                too, and nothing here refuses a run. */}
            {wrongPath && (
              <p className="status-running">
                your build reads <code>{propertiesPath}</code> — this would be written to{" "}
                <code>{stored.fields["properties_path"]}</code>, so the release build would sign with the debug key
              </p>
            )}

            {/* The names the block reaches the lanes under, correctable here for
                the same reason the fields are: a Fastfile that turns out to read
                another name is not a reason to upload a keystore again. */}
            <div className="dim">exported as</div>
            <ul className="field-list">
              {Object.entries(varNames).map(([slot, name]) => (
                <li key={slot}>
                  <span className="pair">
                    <span className="dim key">{slotLabel(spec, slot)}</span>
                    {editing === `name:${slot}` ? (
                      <input
                        autoFocus
                        type="text"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void saveName(slot)}
                        aria-label={`${slotLabel(spec, slot)} variable name`}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    ) : (
                      <code>{name}</code>
                    )}
                  </span>
                  {editing === `name:${slot}` ? (
                    <>
                      <button type="button" disabled={saving} onClick={() => void saveName(slot)}>
                        save
                      </button>
                      <button type="button" onClick={() => setEditing(null)}>
                        cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        onError(null);
                        setDraft(name);
                        setEditing(`name:${slot}`);
                      }}
                    >
                      edit
                    </button>
                  )}
                </li>
              ))}
            </ul>
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

              {/* Only for a block arriving. Replacing the file of one already
                  stored keeps the fields it has: a `.p8` is rotated far more
                  often than the key id beside it, and asking for both again is
                  asking for a chance to get the one that was right wrong. They
                  are corrected a line at a time, above. */}
              {!stored &&
                spec.fields
                  .filter((f) => !f.optional)
                  .map((f) => (
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

            {/* The two settings that cannot be deduced, and the one place on
                this screen where a label beside the box is worth its width: a
                placeholder reading `Properties file, rel…` in a box this wide
                answers nothing. Only where they apply — the keystore. */}
            {!stored && spec.fields.some((f) => f.optional) && (
              <>
                {/* The one line of explanation on this screen, and it is here
                    because the field cannot be understood from its own name:
                    nothing else Laneyard stores writes a file into the clone. */}
                <div className="dim">
                  the properties file your build reads the keystore from — written for the length of a run, only
                  where a release build would otherwise sign with the debug key. Leave empty and Laneyard finds it.
                </div>
                <div className="secret-form">
                {spec.fields
                  .filter((f) => f.optional)
                  .map((f) => (
                    <label key={f.name}>
                      {f.label}
                      <input
                        type="text"
                        style={{ width: "42ch" }}
                        value={valueOf(f)}
                        onChange={(e) => setFields((prev) => ({ ...prev, [f.name]: e.target.value }))}
                        placeholder={suggestionFor(f) ?? "found from your build script"}
                        aria-label={f.label}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                  ))}
                </div>
              </>
            )}

            {/* Answers, not homework. These are the names fastlane itself reads,
                already filled in — the question is only whether this repository
                agrees. A Fastfile that reads `ASC_KEY_FILEPATH`, a private name
                fastlane knows nothing about, is not wrong; it says so here
                rather than being asked to rename anything. */}
            {!stored && (
              <>
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
                </div>
              </>
            )}
            <div className="secret-form">
              <button onClick={() => void store()} disabled={saving || file === null || (!stored && !complete)}>
                {stored ? "replace the file" : "store"}
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

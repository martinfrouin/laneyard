import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

/**
 * A restrained highlight style in the terminal's own palette.
 *
 * CodeMirror's default style is written for a light background and would be
 * unreadable here. These are not new interface colours: they are the exact
 * values the terminal pane already uses for fastlane's ANSI output, which is
 * the one other place in Laneyard that renders code-like text.
 */
const highlight = HighlightStyle.define([
  { tag: tags.comment, color: "#6e7681", fontStyle: "italic" },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "#79c0ff" },
  { tag: [tags.string, tags.special(tags.string)], color: "#7ee787" },
  { tag: [tags.number, tags.bool, tags.atom], color: "#d29922" },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: "#c9d1d9" },
  { tag: tags.typeName, color: "#d2a8ff" },
]);

/**
 * Dark in both themes, like the terminal pane and for the same reason: this is
 * the one surface showing something written for a black background. Right
 * angles, no shadow — the border comes from the `.panel` around it.
 */
const theme = EditorView.theme(
  {
    "&": { backgroundColor: "var(--term-bg)", color: "var(--term-text)", height: "100%" },
    ".cm-content": { fontFamily: "var(--font-mono)", padding: "8px 0" },
    ".cm-gutters": {
      backgroundColor: "var(--term-bg)",
      color: "#4c525c",
      border: "none",
      fontFamily: "var(--font-mono)",
    },
    ".cm-activeLine": { backgroundColor: "#171a1f" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#8b949e" },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "#2d333b",
    },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  },
  { dark: true },
);

/**
 * The Fastfile in a text editor.
 *
 * CodeMirror is bundled, never fetched from a CDN: Laneyard runs on build
 * machines that may have no route to the internet, and an editor that needs one
 * is an outage waiting to happen.
 *
 * The document lives in CodeMirror, not in React state — re-creating the state
 * on every keystroke would throw away the undo history and the cursor. The
 * parent asks for the text when it saves, through `read`.
 */
export function Editor({
  initial,
  baseline,
  read,
  onChange,
  onSave,
}: {
  /**
   * The content to open with, read once. To open a different file, unmount this
   * component and mount another — replacing the document in place would lose
   * the undo history with it.
   */
  initial: string;
  /**
   * What "unchanged" currently means. It moves after a successful save, which
   * must not disturb the document: the file on disk caught up with the editor,
   * the editor did not change.
   */
  baseline: string;
  /** Filled in with a getter for the current text. */
  read: React.RefObject<(() => string) | null>;
  /** Called when the document starts or stops matching `baseline`. */
  onChange: (changed: boolean) => void;
  /** ⌘S / Ctrl-S. Saving stays explicit — this is another way to ask, not an autosave. */
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Kept in a ref so the keymap and the listener never close over a stale prop:
  // the extensions below are built once, at mount, and live for the whole view.
  const latest = useRef({ onChange, onSave, baseline, initial });
  latest.current = { onChange, onSave, baseline, initial };

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: latest.current.initial,
        extensions: [
          // Assembled by hand rather than CodeMirror's `basicSetup`, which
          // pulls in autocompletion and linting: there is no completion source
          // and no linter for a Fastfile, so that is a hundred kilobytes of
          // bundle doing nothing on a machine that may have downloaded it over
          // a build agent's connection.
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          highlightSpecialChars(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          EditorState.allowMultipleSelections.of(true),
          // Ruby has no first-party CodeMirror 6 package; the legacy stream mode
          // is the maintained way to get it, and a Fastfile is Ruby.
          StreamLanguage.define(ruby),
          syntaxHighlighting(highlight),
          theme,
          // No `EditorView.lineWrapping`: a Fastfile is code, and a wrapped line
          // hides its own indentation.
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            // A Fastfile is long enough that finding a lane by eye is a chore.
            ...searchKeymap,
            indentWithTab,
            {
              key: "Mod-s",
              run: () => {
                latest.current.onSave();
                return true; // Stops the browser offering to save the page.
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              latest.current.onChange(update.state.doc.toString() !== latest.current.baseline);
            }
          }),
        ],
      }),
    });

    read.current = () => view.state.doc.toString();
    return () => {
      read.current = null;
      view.destroy();
    };
    // Mount only. A save that succeeds moves `baseline`, and the view must
    // survive it: rebuilding here would drop the undo history and the cursor
    // every time someone pressed save.
  }, [read]);

  return <div className="editor panel" ref={host} />;
}

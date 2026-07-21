import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { ansiToSegments } from "../ansi";

export interface TerminalHandle {
  /** Brings the line that starts at this byte offset to the top of the view. */
  scrollToOffset: (offset: number) => void;
}

/**
 * Index of the line that contains a byte offset.
 *
 * Computed on demand, never on every fragment received: scanning the whole
 * log on every line of output would cost far more than the service it renders.
 */
function lineAtByteOffset(text: string, offset: number): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  let line = 0;
  for (const part of text.split("\n")) {
    bytes += encoder.encode(part).byteLength + 1;
    if (bytes > offset) return line;
    line += 1;
  }
  return line;
}

export function Terminal({
  text,
  handle,
}: {
  text: string;
  handle: RefObject<TerminalHandle | null>;
}) {
  const pre = useRef<HTMLPreElement>(null);
  // Following doesn't resume on its own: as long as the user has scrolled up, we
  // let them read. Nothing is more annoying than a log that yanks the page away.
  const [follow, setFollow] = useState(true);

  const segments = useMemo(() => ansiToSegments(text), [text]);

  useLayoutEffect(() => {
    const el = pre.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [segments, follow]);

  useImperativeHandle(handle, () => ({
    scrollToOffset: (offset: number) => {
      const el = pre.current;
      if (!el) return;
      // With no line wrapping, one line of the log is exactly one line on screen.
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      setFollow(false);
      el.scrollTop = lineAtByteOffset(text, offset) * lineHeight;
    },
  }));

  const onScroll = () => {
    const el = pre.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 8);
  };

  return (
    <div className="terminal panel">
      <div className="pane-title">
        <span className="section">output</span>
        {/* Following only signals itself when suspended: saying so when
            everything's fine would teach nothing and add noise to every screen. */}
        {!follow && <span className="dim">following suspended — scroll to bottom to resume</span>}
      </div>

      <pre ref={pre} onScroll={onScroll}>
        {segments.map((s, i) => (
          <span key={i} className={s.className}>
            {s.text}
          </span>
        ))}
        {text === "" && <span className="dim">waiting for output…</span>}
      </pre>

      {/*
        The input line stays visible, disabled, with its reason: hiding it
        would suggest input might be possible elsewhere.
      */}
      <div className="terminal-input">
        <span className="prompt">$</span>
        <input disabled value="" readOnly aria-label="terminal input" />
        <span className="reason">interactive mode disabled</span>
      </div>
    </div>
  );
}

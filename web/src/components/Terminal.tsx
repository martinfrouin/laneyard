import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { ansiToSegments } from "../ansi";

export interface TerminalHandle {
  /** Amène la ligne qui commence à ce décalage en octets en haut de la vue. */
  scrollToOffset: (offset: number) => void;
}

/**
 * Index de la ligne qui contient un décalage en octets.
 *
 * Calculé à la demande, jamais à chaque fragment reçu : parcourir le log entier
 * à chaque ligne de sortie coûterait bien plus que le service rendu.
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
  // Le suivi ne reprend pas tout seul : tant que l'utilisateur est remonté, on
  // le laisse lire. Rien n'est plus agaçant qu'un log qui vous arrache la page.
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
      // Sans repli de ligne, une ligne du log vaut exactement une ligne à l'écran.
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
        <span className="section">sortie</span>
        {/* Le suivi ne se signale que lorsqu'il est suspendu : le dire quand tout
            va bien n'apprendrait rien et ferait du bruit à chaque écran. */}
        {!follow && <span className="dim">suivi suspendu — revenez en bas pour reprendre</span>}
      </div>

      <pre ref={pre} onScroll={onScroll}>
        {segments.map((s, i) => (
          <span key={i} className={s.className}>
            {s.text}
          </span>
        ))}
        {text === "" && <span className="dim">en attente de sortie…</span>}
      </pre>

      {/*
        La ligne de saisie reste visible, désactivée, avec sa raison : la masquer
        laisserait croire qu'une entrée est peut-être possible ailleurs.
      */}
      <div className="terminal-input">
        <span className="prompt">$</span>
        <input disabled value="" readOnly aria-label="entrée du terminal" />
        <span className="reason">mode interactif désactivé</span>
      </div>
    </div>
  );
}

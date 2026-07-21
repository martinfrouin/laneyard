/**
 * Traduction minimale des séquences ANSI de fastlane en segments colorés.
 *
 * On ne reproduit pas un terminal : seuls les attributs de style (SGR) sont
 * interprétés, tout le reste — déplacements de curseur, effacements, séquences
 * OSC — est retiré du texte affiché. C'est assez pour rendre la sortie telle que
 * fastlane l'a voulue, et assez peu pour rester lisible.
 *
 * Les retours à la ligne sont préservés tels quels : le nombre de lignes du texte
 * brut et du texte affiché est le même, ce dont dépend le repérage par décalage.
 */
export interface Segment {
  text: string;
  /** Classe CSS ou chaîne vide : couleurs propres au terminal, jamais des jetons du thème. */
  className: string;
}

const SGR = /\x1b\[([0-9;]*)m/;
/** Toute autre séquence de contrôle : curseur, effacement, OSC, puis les résidus. */
const OTHER = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][0-9A-Za-z]|\x1b./g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

interface Style {
  fg: string | null;
  bold: boolean;
  dim: boolean;
}

const classOf = (s: Style): string =>
  [s.fg ? `a-${s.fg}` : "", s.bold ? "a-bold" : "", s.dim ? "a-dim" : ""].filter(Boolean).join(" ");

function apply(style: Style, params: string): Style {
  const next = { ...style };
  for (const raw of params.split(";")) {
    const code = Number(raw === "" ? "0" : raw);
    if (code === 0) {
      next.fg = null;
      next.bold = false;
      next.dim = false;
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code >= 30 && code <= 37) next.fg = NAMES[code - 30] ?? null;
    else if (code === 39) next.fg = null;
    else if (code >= 90 && code <= 97) next.fg = `bright-${NAMES[code - 90] ?? "white"}`;
  }
  return next;
}

/** Découpe un texte en segments stylés. Les séquences non gérées disparaissent. */
export function ansiToSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let style: Style = { fg: null, bold: false, dim: false };
  let rest = text;

  const push = (chunk: string) => {
    if (!chunk) return;
    const clean = chunk.replace(OTHER, "").replace(CONTROL, "");
    if (!clean) return;
    const className = classOf(style);
    const last = out[out.length - 1];
    if (last && last.className === className) last.text += clean;
    else out.push({ text: clean, className });
  };

  for (;;) {
    const m = SGR.exec(rest);
    if (!m) break;
    push(rest.slice(0, m.index));
    style = apply(style, m[1] ?? "");
    rest = rest.slice(m.index + m[0].length);
  }
  push(rest);
  return out;
}

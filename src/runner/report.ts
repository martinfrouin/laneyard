import { readFile } from "node:fs/promises";

export interface ReportStep {
  idx: number;
  name: string;
  durationMs: number | null;
  status: "success" | "failed";
}

// La branche auto-fermante vient en premier : fastlane écrit les actions réussies
// sous la forme `<testcase … />` et seules les échouées ont un corps. Dans l'autre
// ordre, `[^>]*` avalerait le `/` final et le corps paresseux courrait jusqu'au
// `</testcase>` suivant, fusionnant deux actions et attribuant l'échec à la mauvaise.
const TESTCASE = /<testcase\b([^>]*?)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
// `\b` obligatoire : sans lui, chercher `name=` trouve d'abord la fin de
// `classname=`, que fastlane écrit systématiquement en premier attribut.
/**
 * Décode les entités XML d'une valeur d'attribut.
 *
 * Indispensable : un nom d'action `sh` contient la commande entière, donc
 * volontiers un `&&` ou une redirection, que le rapport écrit `&amp;&amp;`
 * et `&gt;`. Sans décodage, l'interface affiche l'échappement.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decodeXml = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    // Un point de code hors plage ferait lever String.fromCodePoint : on rend
    // l'entité telle quelle plutôt que d'écrouler la lecture du rapport.
    const point =
      code.startsWith("#x") || code.startsWith("#X")
        ? parseInt(code.slice(2), 16)
        : code.startsWith("#")
          ? Number(code.slice(1))
          : null;

    if (point !== null) {
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : whole;
    }
    return ENTITIES[code] ?? whole;
  });

const ATTR = (source: string, name: string): string | null => {
  const raw = new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1];
  return raw === undefined ? null : decodeXml(raw);
};

/**
 * Lit le rapport JUnit que fastlane écrit à chaque exécution.
 * C'est la source qui fait autorité pour les noms, l'ordre, les durées et les échecs.
 *
 * Renvoie null si le rapport est absent ou illisible — cas normal pour un run annulé,
 * expiré, interrompu, ou qui a échoué avant même d'atteindre fastlane.
 */
export async function readReport(path: string): Promise<ReportStep[] | null> {
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (!xml.includes("<testsuite")) return null;

  const steps: ReportStep[] = [];
  for (const m of xml.matchAll(TESTCASE)) {
    const attrs = m[1] ?? m[2] ?? "";
    const body = m[3] ?? "";
    const rawName = ATTR(attrs, "name");
    if (rawName === null) continue;

    // fastlane nomme ses cas « <index>: <action> ».
    const named = /^(\d+):\s*(.+)$/.exec(rawName);
    const time = ATTR(attrs, "time");

    steps.push({
      idx: named ? Number(named[1]) : steps.length,
      name: named ? named[2]!.trim() : rawName.trim(),
      durationMs: time === null ? null : Math.round(Number(time) * 1000),
      status: body.includes("<failure") ? "failed" : "success",
    });
  }

  if (steps.length === 0) return null;

  // L'index vient du nom, pas de la position : rien ne garantit son unicité.
  // Un rapport à plusieurs testsuites, ou mêlant cas numérotés et non numérotés,
  // produit des doublons — et `run_step` a une clé primaire (run_id, idx).
  // On renumérote donc après tri, en gardant l'ordre annoncé.
  return steps
    .sort((a, b) => a.idx - b.idx)
    .map((step, position) => ({ ...step, idx: position }));
}

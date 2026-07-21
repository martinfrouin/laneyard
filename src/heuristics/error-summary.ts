/**
 * Extraction d'une cause d'échec lisible depuis la sortie d'un run.
 *
 * C'est une heuristique : elle connaît fastlane par ses habitudes d'affichage,
 * pas par un contrat. Elle vit donc dans ce module isolé, et respecte la règle
 * qui s'y applique — elle ne bloque rien, ne modifie rien, et ne fait que
 * produire une information d'appoint. Le log intégral reste la référence.
 */

const ANSI = /\x1b\[[0-9;]*m/g;
/** Préfixe d'horodatage que fastlane place en tête de chaque ligne. */
const TIMESTAMP = /^\[\d{2}:\d{2}:\d{2}\]:\s*/;
/** Marqueur que fastlane réserve à la cause finale d'un échec. */
const FASTLANE_ERROR = /^\[!\]\s*(.+)$/;

const NOISE = /^(fastlane finished with errors|fastlane\.tools finished)/i;
const LOOKS_LIKE_FAILURE = /error|failed|failure|échou/i;

/**
 * Rend une phrase affichable à côté d'un run échoué, ou une phrase de repli.
 *
 * L'ordre de préférence suit la fiabilité décroissante : le marqueur explicite
 * de fastlane d'abord, une ligne qui parle d'erreur ensuite, le code de sortie
 * en dernier recours. Le générique « fastlane finished with errors » est écarté :
 * il est toujours présent et n'apprend rien.
 */
export function summarizeFailure(log: string, exitCode: number | null): string {
  const lines = log
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(TIMESTAMP, "").trim())
    .filter((line) => line.length > 0);

  for (const line of [...lines].reverse()) {
    const marked = FASTLANE_ERROR.exec(line);
    if (marked?.[1]) return marked[1].slice(0, 500);
  }

  const mentioning = [...lines]
    .reverse()
    .find((line) => LOOKS_LIKE_FAILURE.test(line) && !NOISE.test(line));
  if (mentioning) return mentioning.slice(0, 500);

  return exitCode === null
    ? "Le run a échoué sans message exploitable"
    : `fastlane s'est arrêté avec le code ${exitCode}`;
}

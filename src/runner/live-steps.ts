/**
 * Repérage des séparateurs d'étape dans la sortie de fastlane, pendant le run.
 *
 * Fragile par nature : c'est du texte destiné aux humains. On n'en conserve donc
 * qu'une seule chose, le décalage en octets où chaque étape commence — la seule
 * information que report.xml ne contient pas. Les noms et durées qui font foi
 * viendront du rapport en fin de run.
 */
// Forme réelle observée, séquences ANSI comprises :
//   [13:14:00]: \x1b[32m--- Step: mkdir -p ../build && echo x > y.ipa ---\x1b[0m
// Le nom n'est pas un identifiant : pour une action `sh`, c'est la commande
// entière, espaces inclus. La capture est donc paresseuse jusqu'aux tirets
// de fermeture, et surtout pas `\S+`.
const SEPARATOR = /-{2,}\s+Step:\s*(.+?)\s+-{2,}/;

export interface LiveStep {
  name: string;
  logOffset: number;
}

export class LiveStepTracker {
  private pending = "";
  private pendingOffset = 0;
  private found: LiveStep[] = [];

  /** `offset` est la position du fragment dans le fichier de log. */
  consume(chunk: string, offset: number): void {
    if (this.pending === "") this.pendingOffset = offset;
    this.pending += chunk;

    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl);
      const lineOffset = this.pendingOffset;

      this.pendingOffset += Buffer.byteLength(this.pending.slice(0, nl + 1), "utf8");
      this.pending = this.pending.slice(nl + 1);

      const m = SEPARATOR.exec(line);
      if (m?.[1]) this.found.push({ name: m[1], logOffset: lineOffset });
    }
  }

  steps(): LiveStep[] {
    return this.found;
  }
}

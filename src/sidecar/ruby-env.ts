import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RubyEnv {
  env: NodeJS.ProcessEnv;
  /** `process` : Ruby savait déjà. `launcher` : environnement repris du lanceur fastlane. */
  source: "process" | "launcher";
}

async function canRequireFastlane(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await exec("ruby", ["-e", 'require "fastlane"'], { env, timeout: 180_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconstitue l'environnement du lanceur `fastlane` quand c'en est un script shell.
 *
 * On n'exécute pas le lanceur : on relit ses affectations `GEM_HOME` et `GEM_PATH`
 * et on les fait évaluer par bash, qui sait développer `${HOME}` et les valeurs par
 * défaut. Approche volontairement étroite — deux variables, rien d'autre.
 */
async function envFromLauncher(): Promise<NodeJS.ProcessEnv | null> {
  const script = `
    shim=$(command -v fastlane) || exit 1
    head -c 2 "$shim" | grep -q '#!' || exit 1
    eval "$(grep -oE '(GEM_HOME|GEM_PATH)="[^"]*"' "$shim" | sed 's/^/export /')" || exit 1
    [ -n "$GEM_HOME" ] || exit 1
    printf '%s\\n%s\\n' "$GEM_HOME" "$GEM_PATH"
  `;
  try {
    const { stdout } = await exec("bash", ["-c", script], { timeout: 30_000 });
    const [gemHome, gemPath] = stdout.split("\n");
    if (!gemHome) return null;
    return { ...process.env, GEM_HOME: gemHome, GEM_PATH: gemPath || gemHome };
  } catch {
    return null;
  }
}

let cached: Promise<RubyEnv | null> | null = null;

/**
 * Trouve un environnement dans lequel `ruby` peut charger fastlane, ou null.
 *
 * Le résultat est mémorisé : sonder coûte plusieurs secondes, fastlane étant lent
 * à charger, et l'installation ne change pas en cours d'exécution.
 */
export function resolveRubyEnv(): Promise<RubyEnv | null> {
  cached ??= (async () => {
    if (await canRequireFastlane(process.env)) {
      return { env: process.env, source: "process" as const };
    }
    const env = await envFromLauncher();
    if (env && (await canRequireFastlane(env))) {
      return { env, source: "launcher" as const };
    }
    return null;
  })();
  return cached;
}

/** Message unique, pour ne pas décrire le problème différemment à chaque endroit. */
export const FASTLANE_UNAVAILABLE =
  "Ruby ne parvient pas à charger fastlane. Installez-le pour le Ruby courant " +
  "(`gem install fastlane`), ou déclarez un Gemfile dans le projet et passez le " +
  "réglage `runtime` à `bundle`.";

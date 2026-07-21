import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitAuth {
  kind: "none" | "ssh_key" | "token";
  ref?: string;
}

/**
 * Un clone géré par Laneyard, conservé entre les runs.
 * Toutes les commandes git passent par ici pour partager l'environnement d'authentification.
 */
export class Workspace {
  constructor(
    readonly path: string,
    private readonly gitUrl: string,
    private readonly auth: GitAuth = { kind: "none" },
  ) {}

  private env(): NodeJS.ProcessEnv {
    // Sans cela, git peut bloquer sur une demande d'identifiants et figer le run.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (this.auth.kind === "ssh_key" && this.auth.ref) {
      env["GIT_SSH_COMMAND"] = `ssh -i ${this.auth.ref} -o IdentitiesOnly=yes -o BatchMode=yes`;
    }
    return env;
  }

  /**
   * Remplace l'URL du dépôt par un jeton neutre dans un texte.
   *
   * Une URL HTTPS peut porter un mot de passe — `https://user:token@github.com/…`
   * est parfaitement légal dans `config.yml`. Or les erreurs git finissent dans
   * le fichier de log du run. Le caviardage général des secrets viendra au jalon
   * suivant ; cette fuite-ci vient de notre propre formatage, elle se répare ici.
   */
  private redact(text: string): string {
    return text.split(this.gitUrl).join("<dépôt>");
  }

  private async git(args: string[], cwd = this.path): Promise<string> {
    try {
      const { stdout } = await exec("git", args, { cwd, env: this.env(), maxBuffer: 32 * 1024 * 1024 });
      return stdout.trim();
    } catch (cause) {
      const err = cause as { stderr?: string; message: string };
      const detail = (err.stderr || err.message).trim();
      throw new Error(`git ${this.redact(args.join(" "))} a échoué : ${this.redact(detail)}`);
    }
  }

  async exists(): Promise<boolean> {
    try {
      await access(join(this.path, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Vrai s'il existe des modifications *suivies* non commitées.
   *
   * Les fichiers non suivis sont volontairement ignorés : un build en sème
   * (fastlane réécrit `fastlane/README.md` à chaque exécution, les artefacts
   * atterrissent dans `build/`), et surtout `git checkout` ne les détruit pas.
   * Les compter rendrait tout second run impossible sans protéger quoi que ce soit.
   */
  async isDirty(): Promise<boolean> {
    if (!(await this.exists())) return false;
    return (await this.git(["status", "--porcelain", "--untracked-files=no"])) !== "";
  }

  async headSha(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  /**
   * Garantit la présence du clone, sans toucher à la branche courante.
   *
   * Nécessaire avant toute lecture du dépôt hors run — lister les lanes, lire le
   * laneyard.yml — puisque ces informations vivent dans les fichiers du projet.
   */
  async ensureCloned(onProgress?: (line: string) => void): Promise<void> {
    if (await this.exists()) return;
    onProgress?.(`Clonage de ${this.redact(this.gitUrl)}…`);
    await this.git(["clone", this.gitUrl, this.path], process.cwd());
  }

  /**
   * Amène le workspace sur la branche demandée, à jour.
   * Clone au premier appel, se contente d'un fetch ensuite.
   */
  async prepare(branch: string, onProgress?: (line: string) => void): Promise<string> {
    if (!(await this.exists())) {
      await this.ensureCloned(onProgress);
    } else {
      if (await this.isDirty()) {
        throw new Error(
          "Le workspace contient des modifications non commitées. " +
            "Committez-les ou nettoyez le workspace avant de lancer un run.",
        );
      }
      onProgress?.("Récupération des nouveautés…");
      await this.git(["fetch", "--prune", "origin"]);
    }

    onProgress?.(`Bascule sur ${branch}…`);
    await this.git(["checkout", "-q", "-B", branch, `origin/${branch}`]);
    return this.headSha();
  }
}

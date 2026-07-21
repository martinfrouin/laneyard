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
 * A clone managed by Laneyard, kept between runs.
 * All git commands go through here to share the authentication environment.
 */
export class Workspace {
  constructor(
    readonly path: string,
    private readonly gitUrl: string,
    private readonly auth: GitAuth = { kind: "none" },
  ) {}

  private env(): NodeJS.ProcessEnv {
    // Without this, git can block on a credentials prompt and freeze the run.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (this.auth.kind === "ssh_key" && this.auth.ref) {
      env["GIT_SSH_COMMAND"] = `ssh -i ${this.auth.ref} -o IdentitiesOnly=yes -o BatchMode=yes`;
    }
    return env;
  }

  /**
   * Replaces the repository URL with a neutral token in a piece of text.
   *
   * An HTTPS URL can carry a password — `https://user:token@github.com/…`
   * is perfectly legal in `config.yml`. But git errors end up in the run's
   * log file. The vault's redaction does not help here: the repository URL is
   * configuration, not a stored secret, so this leak — which comes from our own
   * formatting — has to be closed on the spot.
   */
  private redact(text: string): string {
    return text.split(this.gitUrl).join("<repository>");
  }

  private async git(args: string[], cwd = this.path): Promise<string> {
    try {
      const { stdout } = await exec("git", args, { cwd, env: this.env(), maxBuffer: 32 * 1024 * 1024 });
      return stdout.trim();
    } catch (cause) {
      const err = cause as { stderr?: string; message: string };
      const detail = (err.stderr || err.message).trim();
      throw new Error(`git ${this.redact(args.join(" "))} failed: ${this.redact(detail)}`);
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
   * True if there are uncommitted changes to *tracked* files.
   *
   * Untracked files are deliberately ignored: a build scatters them around
   * (fastlane rewrites `fastlane/README.md` on every run, artifacts land in
   * `build/`), and above all `git checkout` doesn't destroy them. Counting
   * them would make every second run impossible without protecting anything.
   */
  async isDirty(): Promise<boolean> {
    if (!(await this.exists())) return false;
    return (await this.git(["status", "--porcelain", "--untracked-files=no"])) !== "";
  }

  async headSha(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  /**
   * Guarantees the clone is present, without touching the current branch.
   *
   * Needed before any read of the repository outside a run — listing lanes,
   * reading laneyard.yml — since that information lives in the project's files.
   */
  async ensureCloned(onProgress?: (line: string) => void): Promise<void> {
    if (await this.exists()) return;
    onProgress?.(`Cloning ${this.redact(this.gitUrl)}…`);
    await this.git(["clone", this.gitUrl, this.path], process.cwd());
  }

  /**
   * Brings the workspace to the requested branch, up to date.
   * Clones on the first call, just fetches afterwards.
   */
  async prepare(branch: string, onProgress?: (line: string) => void): Promise<string> {
    if (!(await this.exists())) {
      await this.ensureCloned(onProgress);
    } else {
      if (await this.isDirty()) {
        throw new Error(
          "The workspace has uncommitted changes. " +
            "Commit them or clean the workspace before starting a run.",
        );
      }
      onProgress?.("Fetching updates…");
      await this.git(["fetch", "--prune", "origin"]);
    }

    onProgress?.(`Switching to ${branch}…`);
    await this.git(["checkout", "-q", "-B", branch, `origin/${branch}`]);
    return this.headSha();
  }
}

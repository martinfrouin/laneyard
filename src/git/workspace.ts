import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitAuth {
  kind: "none" | "ssh_key";
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

  private async git(args: string[], cwd = this.path, timeout?: number): Promise<string> {
    return (await this.gitRaw(args, cwd, timeout)).trim();
  }

  /**
   * Same as `git`, but without trimming the output.
   *
   * `status --porcelain` output is column-sensitive: its first two characters
   * are a status code that can themselves be a literal space. Trimming the
   * whole blob — fine for a commit hash or a single config value — would eat
   * that leading space and misalign every line parsed after it.
   */
  private async gitRaw(args: string[], cwd = this.path, timeout?: number): Promise<string> {
    try {
      const { stdout } = await exec("git", args, {
        cwd,
        env: this.env(),
        maxBuffer: 32 * 1024 * 1024,
        ...(timeout === undefined ? {} : { timeout }),
      });
      return stdout;
    } catch (cause) {
      const err = cause as { stderr?: string; message: string };
      const detail = (err.stderr || err.message).trim();
      throw new Error(`git ${this.redact(args.join(" "))} failed: ${this.redact(detail)}`);
    }
  }

  /**
   * Asks the remote for its branches, and nothing else.
   *
   * Reads no working copy and writes nothing, so it answers the one question
   * the readiness checklist asks: would a run reach this repository on its own?
   * The timeout matters as much as the exit code — with `GIT_TERMINAL_PROMPT=0`
   * git gives up on a credentials prompt, but a host that never answers would
   * otherwise hang the checklist exactly the way it hangs a run at 2am.
   */
  async probeRemote(timeoutMs = 10_000): Promise<void> {
    await this.git(["ls-remote", "--heads", this.gitUrl], process.cwd(), timeoutMs);
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
   * Paths with uncommitted changes, tracked only — the same rule as
   * `isDirty`, for the same reason: a build scatters untracked files around,
   * and listing them here would bury the change someone actually made.
   */
  async status(): Promise<string[]> {
    const raw = await this.gitRaw(["status", "--porcelain", "--untracked-files=no"]);
    // Porcelain v1: two status letters, a space, then the path. The trailing
    // split produces one empty element for the final newline; drop it rather
    // than turn it into a bogus empty path.
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3));
  }

  /** The unified diff of uncommitted changes, as text. Every path if none is given. */
  async diff(path?: string): Promise<string> {
    return this.git(path === undefined ? ["diff"] : ["diff", "--", path]);
  }

  /**
   * Stages exactly the given paths and commits them — never `git add -A`. A
   * build leaves files scattered in the workspace, and committing them
   * because they happened to be there is how something ends up in someone's
   * release.
   *
   * Commits under the repository's own git identity if it has one; otherwise
   * as `Laneyard <laneyard@localhost>`, because a commit from a name nobody
   * recognises is worse than one that admits what made it. The identity
   * actually used is returned so the interface can say so.
   */
  async commit(message: string, paths: string[]): Promise<{ author: string }> {
    if (paths.length === 0) throw new Error("commit: no paths given");
    await this.git(["add", "--", ...paths]);

    const identity = await this.gitIdentity();
    const author = identity ?? "Laneyard <laneyard@localhost>";
    const asLaneyard = identity
      ? []
      : ["-c", "user.name=Laneyard", "-c", "user.email=laneyard@localhost"];
    await this.git([...asLaneyard, "commit", "-m", message]);
    return { author };
  }

  /**
   * `name <email>` from the repository's own git configuration — local or
   * global, however git itself resolves it for this workspace — or null if
   * none is set at all.
   */
  private async gitIdentity(): Promise<string | null> {
    try {
      const name = await this.git(["config", "user.name"]);
      const email = await this.git(["config", "user.email"]);
      return name && email ? `${name} <${email}>` : null;
    } catch {
      return null;
    }
  }

  /** Pushes the branch, surfacing git's own message on failure rather than a generic one. */
  async push(branch: string): Promise<void> {
    await this.git(["push", "origin", branch]);
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

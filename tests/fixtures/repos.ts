import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Creates a local git repository serving as a "remote" in the tests. */
export async function makeOriginRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "laneyard-origin-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Test"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    await run("mkdir", ["-p", join(dir, name, "..")]).catch(() => {});
    await writeFile(join(dir, name), content, "utf8");
  }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

export async function commitTo(repo: string, name: string, content: string): Promise<string> {
  await writeFile(join(repo, name), content, "utf8");
  await run("git", ["add", "-A"], { cwd: repo });
  await run("git", ["commit", "-q", "-m", `edit ${name}`], { cwd: repo });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repo });
  return stdout.trim();
}

export async function tmpDir(prefix = "laneyard-ws-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadServerConfig } from "../../src/config/load.js";

async function withConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "laneyard-"));
  const path = join(dir, "config.yml");
  await writeFile(path, yaml, "utf8");
  return path;
}

const minimal = `
server:
  password_hash: "scrypt$aaa$bbb"
projects:
  - slug: sample-ios
    git_url: git@github.com:martin/sample.git
`;

describe("loadServerConfig", () => {
  it("applies the server's default values", async () => {
    const res = await loadServerConfig(await withConfig(minimal));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.server.port).toBe(7890);
    expect(res.config.server.bind).toBe("0.0.0.0");
    expect(res.config.server.max_concurrent_runs).toBe(1);
    expect(res.config.server.retention).toEqual({ runs: 50, artifact_days: 30 });
  });

  it("derives a project's name from its slug", async () => {
    const res = await loadServerConfig(await withConfig(minimal));
    if (!res.ok) throw new Error("expected valid");
    expect(res.config.projects[0]!.name).toBe("sample-ios");
    expect(res.config.projects[0]!.default_branch).toBe("main");
  });

  it("refuses two projects sharing the same slug", async () => {
    const res = await loadServerConfig(
      await withConfig(`
server: { password_hash: "x" }
projects:
  - { slug: a, git_url: u1 }
  - { slug: a, git_url: u2 }
`),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/slug/i);
  });

  it("refuses a slug that isn't usable in a path", async () => {
    const res = await loadServerConfig(
      await withConfig(`
server: { password_hash: "x" }
projects:
  - { slug: "../evil", git_url: u }
`),
    );
    expect(res.ok).toBe(false);
  });

  it("reports a readable error on invalid YAML", async () => {
    const res = await loadServerConfig(await withConfig("server: {"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.length).toBeGreaterThan(0);
  });

  it("reports a missing file without throwing", async () => {
    const res = await loadServerConfig("/does/not/exist/config.yml");
    expect(res.ok).toBe(false);
  });
});

describe("git_auth", () => {
  it("refuses a kind the workspace cannot honour", async () => {
    // Accepting `token` would leave a project configured for an authentication
    // that never happens. A refusal at load time is the honest answer.
    const res = await loadServerConfig(
      await withConfig(`
server: { password_hash: "x" }
projects:
  - slug: a
    git_url: https://example.com/a.git
    git_auth: { kind: token, ref: MY_TOKEN }
`),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/git_auth/);
  });
});

describe("max_concurrent_runs", () => {
  it("refuses a concurrency the queue cannot honour", async () => {
    // Accepting 4 would promise parallel builds that never happen. Parallel runs
    // need a working directory per run; until then, saying no is the honest answer.
    const res = await loadServerConfig(
      await withConfig(`
server: { password_hash: "x", max_concurrent_runs: 4 }
projects: []
`),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The field is named in the message: `load.ts` prefixes it with the path,
    // and an error reading `(root)` would leave the reader hunting for it.
    expect(res.error).toMatch(/server\.max_concurrent_runs: only 1 is supported/);
  });

  it("accepts the one value it honours", async () => {
    const res = await loadServerConfig(
      await withConfig(`
server: { password_hash: "x", max_concurrent_runs: 1 }
projects: []
`),
    );
    expect(res.ok).toBe(true);
  });
});

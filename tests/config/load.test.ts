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
  - slug: popotes-ios
    git_url: git@github.com:martin/popotes.git
`;

describe("loadServerConfig", () => {
  it("applique les valeurs par défaut du serveur", async () => {
    const res = await loadServerConfig(await withConfig(minimal));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.server.port).toBe(7890);
    expect(res.config.server.bind).toBe("0.0.0.0");
    expect(res.config.server.max_concurrent_runs).toBe(1);
    expect(res.config.server.retention).toEqual({ runs: 50, artifact_days: 30 });
  });

  it("déduit le nom d'un projet depuis son slug", async () => {
    const res = await loadServerConfig(await withConfig(minimal));
    if (!res.ok) throw new Error("attendu valide");
    expect(res.config.projects[0]!.name).toBe("popotes-ios");
    expect(res.config.projects[0]!.default_branch).toBe("main");
  });

  it("refuse deux projets partageant le même slug", async () => {
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

  it("refuse un slug qui n'est pas utilisable dans un chemin", async () => {
    const res = await loadServerConfig(
      await withConfig(`
server: { password_hash: "x" }
projects:
  - { slug: "../evil", git_url: u }
`),
    );
    expect(res.ok).toBe(false);
  });

  it("rapporte une erreur lisible sur un YAML invalide", async () => {
    const res = await loadServerConfig(await withConfig("server: {"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.length).toBeGreaterThan(0);
  });

  it("rapporte un fichier absent sans lever d'exception", async () => {
    const res = await loadServerConfig("/nexiste/pas/config.yml");
    expect(res.ok).toBe(false);
  });
});

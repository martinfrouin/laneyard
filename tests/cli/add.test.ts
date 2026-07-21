import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addProjectToConfig } from "../../src/cli/add.js";
import { tmpDir } from "../fixtures/repos.js";

const EXISTING = `# Ma configuration Laneyard
server:
  port: 7890
  password_hash: "scrypt$a$b"   # mot de passe du serveur

projects:
  - slug: deja-la
    git_url: git@example.com:a.git
`;

async function configAt(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-add-");
  const path = join(dir, "config.yml");
  await writeFile(path, content, "utf8");
  return path;
}

const entry = {
  slug: "popotes-ios",
  name: "Popotes iOS",
  git_url: "git@example.com:popotes.git",
  default_branch: "main",
  fastlane_dir: "fastlane",
  runtime: "system" as const,
  artifact_globs: ["**/*.ipa"],
};

describe("addProjectToConfig", () => {
  it("ajoute le projet sans supprimer les projets existants", async () => {
    const path = await configAt(EXISTING);
    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as { projects: { slug: string }[] };
    expect(parsed.projects.map((p) => p.slug)).toEqual(["deja-la", "popotes-ios"]);
  });

  it("préserve les commentaires du fichier", async () => {
    const path = await configAt(EXISTING);
    await addProjectToConfig(path, entry);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("# Ma configuration Laneyard");
    expect(raw).toContain("# mot de passe du serveur");
  });

  it("refuse un slug déjà pris", async () => {
    const path = await configAt(EXISTING);
    await expect(addProjectToConfig(path, { ...entry, slug: "deja-la" })).rejects.toThrow(/deja-la/);
  });

  it("crée le fichier et la section serveur s'il n'existe pas", async () => {
    const dir = await tmpDir("laneyard-add-");
    const path = join(dir, "config.yml");

    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as {
      server: { password_hash: string };
      projects: unknown[];
    };
    expect(parsed.projects).toHaveLength(1);
    // Un mot de passe doit exister, sinon le serveur refuserait toute connexion.
    expect(parsed.server.password_hash).toMatch(/^scrypt\$/);
  });

  it("ajoute une section projects absente d'un fichier existant", async () => {
    const path = await configAt('server:\n  password_hash: "scrypt$a$b"\n');
    await addProjectToConfig(path, entry);

    const parsed = parse(await readFile(path, "utf8")) as { projects: unknown[] };
    expect(parsed.projects).toHaveLength(1);
  });
});

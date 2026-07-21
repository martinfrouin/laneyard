import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../../src/git/workspace.js";
import { commitTo, makeOriginRepo, tmpDir } from "../fixtures/repos.js";

describe("Workspace", () => {
  it("clone au premier accès puis se déclare prêt", async () => {
    const origin = await makeOriginRepo({ "README.md": "hello" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);

    expect(await ws.exists()).toBe(false);
    await ws.prepare("main");
    expect(await ws.exists()).toBe(true);
    expect(await readFile(join(ws.path, "README.md"), "utf8")).toBe("hello");
  }, 30_000);

  it("récupère les nouveaux commits au run suivant", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");

    const sha = await commitTo(origin, "a.txt", "v2");
    await ws.prepare("main");

    expect(await readFile(join(ws.path, "a.txt"), "utf8")).toBe("v2");
    expect(await ws.headSha()).toBe(sha);
  }, 30_000);

  it("refuse de préparer par-dessus des modifications non commitées", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");
    await writeFile(join(ws.path, "a.txt"), "modifié à la main", "utf8");

    expect(await ws.isDirty()).toBe(true);
    await expect(ws.prepare("main")).rejects.toThrow(/non commit/i);
  }, 30_000);

  it("ne se déclare pas sale pour des fichiers non suivis laissés par un build", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await ws.prepare("main");

    // Ce que produit un vrai run : fastlane réécrit son README, le build sort un binaire.
    await writeFile(join(ws.path, "README-fastlane.md"), "généré", "utf8");

    expect(await ws.isDirty()).toBe(false);
    // Et le run suivant doit pouvoir préparer le workspace.
    await expect(ws.prepare("main")).resolves.toMatch(/^[0-9a-f]{40}$/);
  }, 30_000);

  it("échoue lisiblement sur une branche inconnue", async () => {
    const origin = await makeOriginRepo({ "a.txt": "v1" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);
    await expect(ws.prepare("nexiste-pas")).rejects.toThrow(/nexiste-pas/);
  }, 30_000);

  it("clone à la demande sans basculer de branche", async () => {
    const origin = await makeOriginRepo({ "laneyard.yml": "runtime: system\n" });
    const ws = new Workspace(join(await tmpDir(), "p"), origin);

    await ws.ensureCloned();
    expect(await ws.exists()).toBe(true);

    // Idempotent : un second appel ne refait rien et ne lève pas.
    await ws.ensureCloned();
    expect(await ws.exists()).toBe(true);
  }, 30_000);

  it("ne recopie jamais l'URL du dépôt dans un message d'erreur", async () => {
    // Une URL HTTPS peut porter un jeton ; ces messages finissent dans le log du run.
    const secret = "https://user:ghp_TRESSECRET@example.invalid/m/demo.git";
    const ws = new Workspace(join(await tmpDir(), "p"), secret);

    await expect(ws.prepare("main")).rejects.toThrow();
    await ws.prepare("main").catch((err: Error) => {
      expect(err.message).not.toContain("ghp_TRESSECRET");
      expect(err.message).toContain("<dépôt>");
    });
  }, 30_000);
});

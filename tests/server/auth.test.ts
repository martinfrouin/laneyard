import { describe, expect, it } from "vitest";
import { hashPassword, LoginThrottle, verifyPassword } from "../../src/server/auth.js";

describe("verifyPassword", () => {
  it("accepte le bon mot de passe et refuse les autres", async () => {
    const stored = hashPassword("correct horse");
    expect(await verifyPassword("correct horse", stored)).toBe(true);
    expect(await verifyPassword("correct hors", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("refuse au lieu de lever quand l'empreinte stockée est corrompue", async () => {
    // Une configuration abîmée doit produire un refus, pas une erreur serveur.
    for (const corrupted of ["", "scrypt$", "scrypt$zz$zz", "bcrypt$a$b", "scrypt$aa$"]) {
      expect(await verifyPassword("x", corrupted)).toBe(false);
    }
  });

  it("ne bloque pas la boucle d'événements", async () => {
    const stored = hashPassword("mot de passe");
    let ticked = false;
    // Un timer à 0 ms ne peut se déclencher que si la boucle reste libre.
    setTimeout(() => (ticked = true), 0);
    await verifyPassword("mot de passe", stored);
    expect(ticked).toBe(true);
  });
});

describe("LoginThrottle", () => {
  it("laisse passer les premiers essais sans gêner l'utilisateur distrait", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 3; i += 1) t.recordFailure(0);
    expect(t.retryAfterMs(0)).toBe(0);
  });

  it("freine ensuite, de plus en plus", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 4; i += 1) t.recordFailure(0);
    expect(t.retryAfterMs(0)).toBe(1000);

    t.recordFailure(0);
    expect(t.retryAfterMs(0)).toBe(2000);
  });

  it("plafonne le délai plutôt que de bloquer indéfiniment", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 40; i += 1) t.recordFailure(0);
    expect(t.retryAfterMs(0)).toBe(60_000);
  });

  it("oublie tout dès une connexion réussie", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 10; i += 1) t.recordFailure(0);
    t.recordSuccess();
    expect(t.retryAfterMs(0)).toBe(0);
  });
});

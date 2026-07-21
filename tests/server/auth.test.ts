import { describe, expect, it } from "vitest";
import { hashPassword, LoginThrottle, verifyPassword } from "../../src/server/auth.js";

describe("verifyPassword", () => {
  it("accepts the right password and refuses others", async () => {
    const stored = hashPassword("correct horse");
    expect(await verifyPassword("correct horse", stored)).toBe(true);
    expect(await verifyPassword("correct hors", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("refuses instead of throwing when the stored hash is corrupted", async () => {
    // A broken configuration must produce a refusal, not a server error.
    for (const corrupted of ["", "scrypt$", "scrypt$zz$zz", "bcrypt$a$b", "scrypt$aa$"]) {
      expect(await verifyPassword("x", corrupted)).toBe(false);
    }
  });

  it("doesn't block the event loop", async () => {
    const stored = hashPassword("a password");
    let ticked = false;
    // A 0ms timer can only fire if the event loop stays free.
    setTimeout(() => (ticked = true), 0);
    await verifyPassword("a password", stored);
    expect(ticked).toBe(true);
  });
});

describe("LoginThrottle", () => {
  it("lets the first attempts through without bothering the distracted user", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 3; i += 1) t.recordFailure(0);
    expect(t.retryAfterMs(0)).toBe(0);
  });

  it("then slows down, more and more", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 4; i += 1) t.recordFailure(0);
    expect(t.retryAfterMs(0)).toBe(1000);

    t.recordFailure(0);
    expect(t.retryAfterMs(0)).toBe(2000);
  });

  it("caps the delay rather than blocking indefinitely", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 40; i += 1) t.recordFailure(0);
    expect(t.retryAfterMs(0)).toBe(60_000);
  });

  it("forgets everything as soon as a login succeeds", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 10; i += 1) t.recordFailure(0);
    t.recordSuccess();
    expect(t.retryAfterMs(0)).toBe(0);
  });
});

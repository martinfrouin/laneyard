import { describe, expect, it } from "vitest";
import {
  authenticate,
  hashPassword,
  LoginThrottle,
  SessionStore,
  verifyPassword,
} from "../../src/server/auth.js";
import type { UserEntry } from "../../src/config/schema.js";

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

const users: UserEntry[] = [
  { name: "martin", role: "admin", password_hash: hashPassword("admin pass") },
  { name: "ci", role: "builder", password_hash: hashPassword("builder pass") },
];

describe("authenticate", () => {
  it("returns who the caller is, not merely that they are someone", async () => {
    expect(await authenticate(users, "martin", "admin pass")).toEqual({
      name: "martin",
      role: "admin",
    });
    expect(await authenticate(users, "ci", "builder pass")).toEqual({
      name: "ci",
      role: "builder",
    });
  });

  it("refuses a wrong password", async () => {
    expect(await authenticate(users, "martin", "builder pass")).toBeNull();
  });

  it("refuses an unknown name", async () => {
    expect(await authenticate(users, "nobody", "admin pass")).toBeNull();
  });

  it("costs the same on an unknown name as on a wrong password", async () => {
    // Otherwise the login form answers "does this account exist?" in the time
    // it takes to reply, and an attacker learns who to target before trying a
    // single password. The comparison is a ratio with wide margins on purpose:
    // it catches the real mistake — skipping the hash entirely, which is
    // hundreds of times faster — without being a benchmark.
    const fastest = async (name: string): Promise<number> => {
      let best = Infinity;
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        await authenticate(users, name, "some password");
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };

    const wrongPassword = await fastest("martin");
    const unknownName = await fastest("nobody");
    expect(unknownName).toBeGreaterThan(wrongPassword * 0.5);
  });
});

describe("SessionStore", () => {
  it("maps a token to who owns it", () => {
    const store = new SessionStore();
    const token = store.issue({ name: "ci", role: "builder" });
    expect(store.get(token)).toEqual({ name: "ci", role: "builder" });
    expect(store.valid(token)).toBe(true);
  });

  it("knows nothing about a token it never issued", () => {
    const store = new SessionStore();
    expect(store.get("made up")).toBeUndefined();
    expect(store.get(undefined)).toBeUndefined();
    expect(store.valid(undefined)).toBe(false);
  });

  it("forgets a revoked token", () => {
    const store = new SessionStore();
    const token = store.issue({ name: "ci", role: "builder" });
    store.revoke(token);
    expect(store.get(token)).toBeUndefined();
  });

  it("gives two sessions of the same account distinct tokens", () => {
    const store = new SessionStore();
    const a = store.issue({ name: "ci", role: "builder" });
    const b = store.issue({ name: "ci", role: "builder" });
    expect(a).not.toBe(b);
  });
});

describe("LoginThrottle", () => {
  it("lets the first attempts through without bothering the distracted user", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 3; i += 1) t.recordFailure("martin", 0);
    expect(t.retryAfterMs("martin", 0)).toBe(0);
  });

  it("then slows down, more and more", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 4; i += 1) t.recordFailure("martin", 0);
    expect(t.retryAfterMs("martin", 0)).toBe(1000);

    t.recordFailure("martin", 0);
    expect(t.retryAfterMs("martin", 0)).toBe(2000);
  });

  it("caps the delay rather than blocking indefinitely", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 40; i += 1) t.recordFailure("martin", 0);
    expect(t.retryAfterMs("martin", 0)).toBe(60_000);
  });

  it("forgets everything as soon as a login succeeds", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 10; i += 1) t.recordFailure("martin", 0);
    t.recordSuccess("martin");
    expect(t.retryAfterMs("martin", 0)).toBe(0);
  });

  it("counts per name, so one account under attack cannot lock out the others", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 20; i += 1) t.recordFailure("martin", 0);
    expect(t.retryAfterMs("martin", 0)).toBeGreaterThan(0);
    expect(t.retryAfterMs("ci", 0)).toBe(0);
  });

  it("does not grow without bound when the names are invented", () => {
    // The name is whatever the attacker sent, so the map is attacker-sized
    // unless entries that no longer delay anyone are dropped.
    const t = new LoginThrottle();
    for (let i = 0; i < 5_000; i += 1) t.recordFailure(`invented-${i}`, 0);
    expect(t.size()).toBeLessThan(2_000);
  });
});

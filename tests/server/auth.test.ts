import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { SessionRecords } from "../../src/db/sessions.js";
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
  // Backed by the database now, so that a restart does not sign everybody out.
  // In memory here: the point under test is the mapping, not the file.
  const newStore = () => new SessionStore(new SessionRecords(openDatabase(":memory:")));

  it("maps a token to who owns it", () => {
    const store = newStore();
    const token = store.issue({ name: "ci", role: "builder" });
    expect(store.get(token)).toEqual({ name: "ci", role: "builder" });
    expect(store.valid(token)).toBe(true);
  });

  it("knows nothing about a token it never issued", () => {
    const store = newStore();
    expect(store.get("made up")).toBeUndefined();
    expect(store.get(undefined)).toBeUndefined();
    expect(store.valid(undefined)).toBe(false);
  });

  it("forgets a revoked token", () => {
    const store = newStore();
    const token = store.issue({ name: "ci", role: "builder" });
    store.revoke(token);
    expect(store.get(token)).toBeUndefined();
  });

  it("gives two sessions of the same account distinct tokens", () => {
    const store = newStore();
    const a = store.issue({ name: "ci", role: "builder" });
    const b = store.issue({ name: "ci", role: "builder" });
    expect(a).not.toBe(b);
  });

  it("drops every session an account had, which is what a password change needs", () => {
    const store = newStore();
    const phone = store.issue({ name: "ci", role: "builder" });
    const laptop = store.issue({ name: "ci", role: "builder" });
    const other = store.issue({ name: "martin", role: "admin" });

    store.revokeAllFor("ci");
    expect(store.get(phone)).toBeUndefined();
    expect(store.get(laptop)).toBeUndefined();
    expect(store.get(other)).toBeDefined();
  });

  /**
   * The whole reason these moved out of a Map: restarting the server to pick up
   * an edit to config.yml used to sign everybody out.
   */
  it("survives the process that issued it", () => {
    const db = openDatabase(":memory:");
    const token = new SessionStore(new SessionRecords(db)).issue({ name: "ci", role: "builder" });

    // A second store over the same database is what a restart amounts to.
    expect(new SessionStore(new SessionRecords(db)).get(token)).toEqual({
      name: "ci",
      role: "builder",
    });
  });

  it("stops honouring a session once its time is up", () => {
    const db = openDatabase(":memory:");
    const records = new SessionRecords(db);
    const store = new SessionStore(records);
    const token = store.issue({ name: "ci", role: "builder" }, new Date("2026-01-01T00:00:00Z"));

    expect(records.find(token, new Date("2026-01-20T00:00:00Z"))).toBeDefined();
    expect(records.find(token, new Date("2026-03-01T00:00:00Z"))).toBeUndefined();
  });

  // The token is a bearer credential: a copy of laneyard.db must be a list of
  // digests, not a ring of working keys.
  it("never writes the token itself down", () => {
    const db = openDatabase(":memory:");
    const token = new SessionStore(new SessionRecords(db)).issue({ name: "ci", role: "builder" });

    const rows = db.prepare("SELECT token_hash FROM session").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
  });

  it("sweeps away what has expired, and leaves what has not", () => {
    const db = openDatabase(":memory:");
    const records = new SessionRecords(db);
    const store = new SessionStore(records);
    store.issue({ name: "ci", role: "builder" }, new Date("2026-01-01T00:00:00Z"));
    store.issue({ name: "ci", role: "builder" }, new Date("2026-06-01T00:00:00Z"));

    expect(records.prune(new Date("2026-02-01T00:00:00Z"))).toBe(1);
    expect(records.count(new Date("2026-02-01T00:00:00Z"))).toBe(1);
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

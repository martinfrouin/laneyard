import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type { UserEntry, UserRole } from "../config/schema.js";

/**
 * scrypt from the standard library: no extra native dependency, and enough
 * computational resistance for a single local password.
 * Format: scrypt$<hex salt>$<hex key>.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Verifies a password without blocking the event loop.
 *
 * scrypt costs some thirty milliseconds per call — that's the point. But in
 * its synchronous form, every login attempt would freeze the whole server
 * for that long: live logs of runs in progress would stop dead. Anyone on
 * the network could paralyze the machine with a curl loop.
 *
 * Never throws: a corrupted `password_hash` must refuse the login, not
 * turn a configuration error into a 500.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, "hex");
  if (expected.length === 0) return false;

  try {
    const actual = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(saltHex, "hex"), expected.length, (err, key) =>
        err ? reject(err) : resolve(key),
      );
    });
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Who a session belongs to. Never carries a hash: nothing downstream needs one. */
export interface Identity {
  name: string;
  role: UserRole;
}

/**
 * A hash no password matches, used to spend the same work on an unknown name.
 *
 * Built from random bytes rather than by hashing something: `hashPassword` is
 * synchronous and would freeze the server for its duration. The shape is what
 * matters — `verifyPassword` derives a 32-byte key with the same parameters and
 * then fails the comparison, which is exactly what a wrong password costs.
 */
const DECOY_HASH = `scrypt$${randomBytes(16).toString("hex")}$${randomBytes(32).toString("hex")}`;

/**
 * Turns a name and a password into who that is, or into nothing.
 *
 * An unknown name is verified against a decoy hash instead of returning early.
 * Without that, a refusal for a name that does not exist comes back in
 * microseconds while a wrong password takes the thirty milliseconds scrypt
 * costs — and the login form becomes a way to enumerate accounts before trying
 * a single password against them.
 */
export async function authenticate(
  users: readonly UserEntry[],
  name: string,
  password: string,
): Promise<Identity | null> {
  const user = users.find((u) => u.name === name);
  if (!user) {
    await verifyPassword(password, DECOY_HASH);
    return null;
  }
  if (!(await verifyPassword(password, user.password_hash))) return null;
  return { name: user.name, role: user.role };
}

/** In-memory sessions: they don't survive a restart, and that's just fine. */
export class SessionStore {
  private readonly tokens = new Map<string, Identity>();

  issue(identity: Identity): string {
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, identity);
    return token;
  }

  /** Who the token belongs to, or undefined if it belongs to nobody. */
  get(token: string | undefined): Identity | undefined {
    return token === undefined ? undefined : this.tokens.get(token);
  }

  valid(token: string | undefined): boolean {
    return this.get(token) !== undefined;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  /**
   * Drops every session belonging to a name.
   *
   * The identity is snapshotted when the session is issued, which is what makes
   * a request cheap — but it also means removing an account or changing its role
   * leaves the old answer live in whatever browsers already had it. Without this,
   * "remove the account" and "revoke access" are two different things, while
   * every interface that offers the first implies the second.
   */
  revokeAllFor(name: string): void {
    for (const [token, identity] of this.tokens) {
      if (identity.name === name) this.tokens.delete(token);
    }
  }
}

export const SESSION_COOKIE = "laneyard_session";

/** Past this many tracked names, the entries that no longer delay anyone go. */
const THROTTLE_PRUNE_ABOVE = 1_000;

/**
 * Slows down repeated login attempts, one account at a time.
 *
 * Without this, a network neighbour could try passwords as fast as the
 * server responds. The delay grows with failures and resets to zero on a
 * success: the legitimate user who mistypes once doesn't feel it.
 *
 * Counted per name rather than globally: a single counter means anyone able to
 * reach the login form can lock out every account on the server by hammering
 * one name — a denial of service disguised as a security measure.
 */
export class LoginThrottle {
  private readonly perName = new Map<string, { failures: number; until: number }>();

  /** Milliseconds left to wait for that name, 0 if the way is clear. */
  retryAfterMs(name: string, now = Date.now()): number {
    return Math.max(0, (this.perName.get(name)?.until ?? 0) - now);
  }

  recordFailure(name: string, now = Date.now()): void {
    const state = this.perName.get(name) ?? { failures: 0, until: 0 };
    state.failures += 1;
    // 0, 0, 0, then 1s, 2s, 4s… capped at one minute.
    if (state.failures > 3) {
      state.until = now + Math.min(60_000, 2 ** (state.failures - 4) * 1000);
    }
    this.perName.set(name, state);
    // The key is whatever the caller sent, so an attacker chooses how many
    // entries exist. Dropping those whose delay has run out bounds the map by
    // how fast someone can be delayed, not by how many names they can invent.
    if (this.perName.size > THROTTLE_PRUNE_ABOVE) this.prune(now);
  }

  recordSuccess(name: string): void {
    this.perName.delete(name);
  }

  /** Number of names currently tracked. Exposed so the pruning can be tested. */
  size(): number {
    return this.perName.size;
  }

  private prune(now: number): void {
    for (const [name, state] of this.perName) {
      if (state.until <= now) this.perName.delete(name);
    }
  }
}

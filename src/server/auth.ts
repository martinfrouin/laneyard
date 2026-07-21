import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

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

/** In-memory sessions: they don't survive a restart, and that's just fine. */
export class SessionStore {
  private readonly tokens = new Set<string>();

  issue(): string {
    const token = randomBytes(32).toString("hex");
    this.tokens.add(token);
    return token;
  }

  valid(token: string | undefined): boolean {
    return token !== undefined && this.tokens.has(token);
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

export const SESSION_COOKIE = "laneyard_session";

/**
 * Slows down repeated login attempts.
 *
 * Without this, a network neighbour could try passwords as fast as the
 * server responds. The delay grows with failures and resets to zero on a
 * success: the legitimate user who mistypes once doesn't feel it.
 */
export class LoginThrottle {
  private failures = 0;
  private until = 0;

  /** Milliseconds left to wait, 0 if the way is clear. */
  retryAfterMs(now = Date.now()): number {
    return Math.max(0, this.until - now);
  }

  recordFailure(now = Date.now()): void {
    this.failures += 1;
    // 0, 0, 0, then 1s, 2s, 4s… capped at one minute.
    if (this.failures > 3) {
      this.until = now + Math.min(60_000, 2 ** (this.failures - 4) * 1000);
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.until = 0;
  }
}

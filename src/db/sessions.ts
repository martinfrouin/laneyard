import { createHash } from "node:crypto";
import type { Db } from "./open.js";

/** Who a session belongs to. Never carries a hash: nothing downstream needs one. */
export interface SessionOwner {
  name: string;
  role: string;
}

/**
 * A token is never stored, only its digest.
 *
 * SHA-256 without a salt on purpose, unlike a password: the token is 32 random
 * bytes from `randomBytes`, so there is no dictionary to build and no cheaper
 * attack than guessing the token itself. What this buys is that a copy of
 * `laneyard.db` is a list of digests rather than a ring of working keys.
 */
const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

interface Row {
  name: string;
  role: string;
}

/**
 * Where sessions live between restarts.
 *
 * They used to live in a Map, with a comment saying they did not survive a
 * restart "and that's just fine". It was not fine: a server restarted to pick
 * up a configuration change signed everybody out, and on a machine you are
 * still setting up that is several times an hour.
 */
export class SessionRecords {
  constructor(private readonly db: Db) {}

  insert(token: string, owner: SessionOwner, expiresAt: Date): void {
    this.db
      .prepare(
        `INSERT INTO session (token_hash, name, role, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(digest(token), owner.name, owner.role, new Date().toISOString(), expiresAt.toISOString());
  }

  /** The owner, or undefined when the token is unknown or its time is up. */
  find(token: string, now = new Date()): SessionOwner | undefined {
    const row = this.db
      .prepare(`SELECT name, role FROM session WHERE token_hash = ? AND expires_at > ?`)
      .get(digest(token), now.toISOString()) as Row | undefined;
    return row ? { name: row.name, role: row.role } : undefined;
  }

  remove(token: string): void {
    this.db.prepare(`DELETE FROM session WHERE token_hash = ?`).run(digest(token));
  }

  removeAllFor(name: string): void {
    this.db.prepare(`DELETE FROM session WHERE name = ?`).run(name);
  }

  /**
   * Drops what has already expired.
   *
   * Called at startup rather than on a timer: the rows are harmless — `find`
   * already refuses them — so this is housekeeping, not correctness, and a
   * timer would be a moving part earning nothing.
   */
  prune(now = new Date()): number {
    return this.db.prepare(`DELETE FROM session WHERE expires_at <= ?`).run(now.toISOString())
      .changes;
  }

  /** Number of live sessions. Exposed so expiry can be tested without sleeping. */
  count(now = new Date()): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM session WHERE expires_at > ?`)
      .get(now.toISOString()) as { n: number };
    return row.n;
  }
}

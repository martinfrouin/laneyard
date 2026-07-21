import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * scrypt de la bibliothèque standard : aucune dépendance native supplémentaire,
 * et une résistance au calcul suffisante pour un mot de passe unique local.
 * Format : scrypt$<sel hex>$<clé hex>.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

/** Sessions en mémoire : elles ne survivent pas à un redémarrage, et c'est très bien. */
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

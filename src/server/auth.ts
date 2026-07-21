import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

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

/**
 * Vérifie un mot de passe sans bloquer la boucle d'événements.
 *
 * scrypt coûte une trentaine de millisecondes par appel — c'est le but. Mais en
 * version synchrone, chaque tentative de connexion gèle tout le serveur pendant
 * ce temps : les logs en direct des runs en cours s'arrêtent net. Quiconque est
 * sur le réseau pourrait ainsi paralyser la machine avec une boucle de curl.
 *
 * Ne lève jamais : un `password_hash` corrompu doit refuser la connexion, pas
 * transformer une erreur de configuration en 500.
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

/**
 * Freine les tentatives de connexion répétées.
 *
 * Sans cela, un voisin de réseau peut essayer des mots de passe aussi vite que
 * le serveur répond. Le délai croît avec les échecs et se remet à zéro dès une
 * réussite : l'utilisateur légitime qui se trompe une fois ne le sent pas.
 */
export class LoginThrottle {
  private failures = 0;
  private until = 0;

  /** Millisecondes restant à attendre, 0 si la voie est libre. */
  retryAfterMs(now = Date.now()): number {
    return Math.max(0, this.until - now);
  }

  recordFailure(now = Date.now()): void {
    this.failures += 1;
    // 0, 0, 0, puis 1 s, 2 s, 4 s… plafonné à une minute.
    if (this.failures > 3) {
      this.until = now + Math.min(60_000, 2 ** (this.failures - 4) * 1000);
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.until = 0;
  }
}

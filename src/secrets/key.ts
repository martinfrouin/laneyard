import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEY_BYTES = 32;

/**
 * Reads the vault key, creating it on first use.
 *
 * The key lives beside the database but never inside it: someone who walks off
 * with `laneyard.db` gets ciphertext and nothing else.
 *
 * A key another user can read is treated as an error rather than a warning —
 * the same stance `ssh` takes on private keys, and for the same reason: silently
 * carrying on would make the encryption decorative.
 */
export async function loadOrCreateKey(home: string): Promise<Buffer> {
  const path = join(home, "key");

  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `Vault key ${path} is readable by other users. Run \`chmod 600 ${path}\` and start again.`,
      );
    }

    const key = await readFile(path);
    if (key.byteLength !== KEY_BYTES) {
      throw new Error(
        `Vault key ${path} is ${key.byteLength} bytes, expected ${KEY_BYTES}. ` +
          "Refusing to guess: move it aside and Laneyard will create a new one, " +
          "but every stored secret will have to be entered again.",
      );
    }
    return key;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }

  await mkdir(home, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  // The mode is set at creation, not after: a `chmod` afterwards leaves a window
  // during which the key exists and is world-readable.
  await writeFile(path, key, { mode: 0o600 });
  return key;
}

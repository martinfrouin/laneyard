import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateKey } from "../../src/secrets/key.js";
import { tmpDir } from "../fixtures/repos.js";

describe("loadOrCreateKey", () => {
  it("creates a 32-byte key readable only by its owner", async () => {
    const dir = await tmpDir("laneyard-key-");
    const key = await loadOrCreateKey(dir);

    expect(key).toHaveLength(32);
    const info = await stat(join(dir, "key"));
    // 0o777 masks the permission bits: nothing for group, nothing for others.
    expect(info.mode & 0o077).toBe(0);
  });

  it("returns the same key on the next call", async () => {
    const dir = await tmpDir("laneyard-key-");
    const first = await loadOrCreateKey(dir);
    const second = await loadOrCreateKey(dir);
    expect(second.equals(first)).toBe(true);
  });

  it("refuses a key file that others can read", async () => {
    const dir = await tmpDir("laneyard-key-");
    await loadOrCreateKey(dir);
    await chmod(join(dir, "key"), 0o644);

    await expect(loadOrCreateKey(dir)).rejects.toThrow(/readable by other users/i);
  });

  it("refuses a key of the wrong size rather than deriving one", async () => {
    const dir = await tmpDir("laneyard-key-");
    await loadOrCreateKey(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "key"), Buffer.alloc(8), { mode: 0o600 });

    await expect(loadOrCreateKey(dir)).rejects.toThrow(/32/);
  });

  it("writes raw bytes, not text", async () => {
    const dir = await tmpDir("laneyard-key-");
    await loadOrCreateKey(dir);
    expect((await readFile(join(dir, "key"))).byteLength).toBe(32);
  });
});

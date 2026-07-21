# Laneyard — Milestone 2: the secret vault and log redaction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a project's credentials encrypted on disk, hand them to fastlane as environment variables, and make sure they never reach a log file or a browser.

**Architecture:** Secrets live in SQLite, encrypted with AES-256-GCM under a key file that never enters the database. The runner resolves them just before spawning fastlane and builds a redactor from their values; every byte of output passes through that redactor before it is written or broadcast. Redaction happens at the source, not at display time.

**Tech Stack:** Node's built-in `crypto` — no new dependency. Existing stack otherwise: TypeScript, better-sqlite3, Fastify, React.

**Reference:** `docs/superpowers/specs/2026-07-21-laneyard-design.md`, sections "Secret redaction" and the `secret` table.

**Out of scope, deliberately:** the build queue, run cancellation and timeouts surfaced in the UI (milestone 3); the CI readiness checklist (milestone 4); `$SECRET` references inside `config.yml` — the schema already accepts the syntax, resolving it can wait until something other than `webhook_url` needs it.

---

## Why this order

The original milestone list put redaction before the vault. That is backwards: you cannot redact
what you do not know. A redactor needs the exact strings to look for, and the only reliable source
of those is the vault itself. So both ship together, and the README's security section can stop
apologising.

---

## File structure

```
src/
  secrets/
    key.ts         Reads or creates ~/.laneyard/key, refuses a key others can read
    cipher.ts      AES-256-GCM, versioned payload format
    vault.ts       Ties key + cipher + store together; the only thing the rest calls
  db/
    secrets.ts     The `secret` table. Stores ciphertext, never plaintext
  logs/
    redact.ts      Sliding-buffer redactor, safe across chunk boundaries
  server/routes/
    secrets.ts     REST for listing, setting and deleting
web/src/
  pages/Secrets.tsx   The per-project tab
```

Everything that touches plaintext is confined to `vault.ts` and the runner. Nothing else in the
codebase ever sees a decrypted value.

---

### Task 1: The key file

The vault's key lives on disk, never in the database — so a stolen `laneyard.db` is useless on its
own.

**Files:**
- Create: `src/secrets/key.ts`, `tests/secrets/key.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/secrets/key.test.ts`:

```ts
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

    await expect(loadOrCreateKey(dir)).rejects.toThrow(/permission/i);
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- tests/secrets/key.test.ts`
Expected: failure, module not found.

- [ ] **Step 3: Implement**

`src/secrets/key.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/secrets/key.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/secrets/key.ts tests/secrets/key.test.ts
git commit -m "feat(secrets): vault key file, owner-readable only"
```

---

### Task 2: Encryption

**Files:**
- Create: `src/secrets/cipher.ts`, `tests/secrets/cipher.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/secrets/cipher.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../../src/secrets/cipher.js";

const key = randomBytes(32);

describe("encrypt / decrypt", () => {
  it("returns what was put in", () => {
    for (const value of ["", "hunter2", "a".repeat(4096), "clé: éàü 🔑"]) {
      expect(decrypt(encrypt(value, key), key)).toBe(value);
    }
  });

  it("produces a different ciphertext every time for the same input", () => {
    // A deterministic ciphertext would leak that two projects share a password.
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("carries a version marker so the format can change later", () => {
    expect(encrypt("x", key).startsWith("v1.")).toBe(true);
  });

  it("refuses a tampered ciphertext instead of returning garbage", () => {
    const payload = encrypt("hunter2", key);
    const parts = payload.split(".");
    const body = Buffer.from(parts[3]!, "base64");
    body[0] ^= 0xff;
    parts[3] = body.toString("base64");

    expect(() => decrypt(parts.join("."), key)).toThrow();
  });

  it("refuses the wrong key", () => {
    expect(() => decrypt(encrypt("hunter2", key), randomBytes(32))).toThrow();
  });

  it("refuses a payload in an unknown format", () => {
    expect(() => decrypt("v2.a.b.c", key)).toThrow(/format/i);
    expect(() => decrypt("nonsense", key)).toThrow(/format/i);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- tests/secrets/cipher.test.ts`
Expected: failure, module not found.

- [ ] **Step 3: Implement**

`src/secrets/cipher.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM, from Node's standard library — no dependency to audit.
 *
 * GCM is authenticated: a modified ciphertext fails to decrypt rather than
 * producing plausible rubbish, which is what you want for a value that will be
 * handed to a build as a password.
 *
 * Payload format: `v1.<iv>.<tag>.<ciphertext>`, each part base64. The version
 * prefix exists so the format can be changed without guessing what old rows are.
 */
const VERSION = "v1";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(
    ".",
  );
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, bodyB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || bodyB64 === undefined) {
    throw new Error("Unrecognised secret format");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, "base64")), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/secrets/cipher.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/secrets/cipher.ts tests/secrets/cipher.test.ts
git commit -m "feat(secrets): authenticated encryption with a versioned payload"
```

---

### Task 3: The secret table

**Files:**
- Modify: `src/db/schema.sql`
- Create: `src/db/secrets.ts`, `tests/db/secrets.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/db/secrets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";

const store = (): SecretStore => new SecretStore(openDatabase(":memory:"));

describe("SecretStore", () => {
  it("stores and lists a project secret without ever returning its value", () => {
    const s = store();
    s.set("app", "MATCH_PASSWORD", "cipher-blob", true);

    const listed = s.list("app");
    expect(listed).toEqual([
      { key: "MATCH_PASSWORD", masked: true, scope: "project" },
    ]);
    // The listing type has no `value` at all — this is a compile-time guarantee
    // as much as a runtime one.
    expect(JSON.stringify(listed)).not.toContain("cipher-blob");
  });

  it("overwrites a secret of the same name rather than duplicating it", () => {
    const s = store();
    s.set("app", "TOKEN", "first", true);
    s.set("app", "TOKEN", "second", true);

    expect(s.list("app")).toHaveLength(1);
    expect(s.encrypted("app")["TOKEN"]).toBe("second");
  });

  it("keeps global secrets and project secrets apart", () => {
    const s = store();
    s.set(null, "SHARED", "global-value", true);
    s.set("app", "OWN", "project-value", true);

    expect(s.list("app").map((x) => x.key).sort()).toEqual(["OWN", "SHARED"]);
    expect(s.list("other").map((x) => x.key)).toEqual(["SHARED"]);
    expect(s.list("app").find((x) => x.key === "SHARED")?.scope).toBe("global");
  });

  it("lets a project secret win over a global one of the same name", () => {
    const s = store();
    s.set(null, "TOKEN", "global", true);
    s.set("app", "TOKEN", "project", true);

    expect(s.encrypted("app")["TOKEN"]).toBe("project");
    expect(s.encrypted("other")["TOKEN"]).toBe("global");
    // Listed once, not twice, and attributed to the scope that actually applies.
    const shown = s.list("app").filter((x) => x.key === "TOKEN");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.scope).toBe("project");
  });

  it("removes a secret", () => {
    const s = store();
    s.set("app", "TOKEN", "v", true);
    expect(s.remove("app", "TOKEN")).toBe(true);
    expect(s.list("app")).toEqual([]);
    expect(s.remove("app", "TOKEN")).toBe(false);
  });

  it("does not let removing a project secret touch the global one", () => {
    const s = store();
    s.set(null, "TOKEN", "global", true);
    s.set("app", "TOKEN", "project", true);

    s.remove("app", "TOKEN");
    expect(s.encrypted("app")["TOKEN"]).toBe("global");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- tests/db/secrets.test.ts`
Expected: failure, module not found.

- [ ] **Step 3: Add the table**

Append to `src/db/schema.sql`:

```sql
-- A global secret is stored with an empty project_slug rather than NULL:
-- SQLite considers two NULLs distinct in a UNIQUE index, so NULL would let the
-- same global name be inserted twice.
CREATE TABLE IF NOT EXISTS secret (
  project_slug TEXT    NOT NULL DEFAULT '',
  key          TEXT    NOT NULL,
  value_enc    TEXT    NOT NULL,
  masked       INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (project_slug, key)
);
```

- [ ] **Step 4: Implement the store**

`src/db/secrets.ts`:

```ts
import type { Db } from "./open.js";

export type Scope = "project" | "global";

/** What a listing may expose. There is deliberately no value here. */
export interface SecretSummary {
  key: string;
  masked: boolean;
  scope: Scope;
}

const GLOBAL = "";

interface Row {
  project_slug: string;
  key: string;
  value_enc: string;
  masked: number;
}

/**
 * Stores encrypted secrets. Knows nothing about encryption itself: it takes and
 * returns ciphertext, so a bug here cannot leak a plaintext value.
 *
 * A project secret shadows a global one of the same name — the same precedence
 * as the configuration, and the least surprising rule.
 */
export class SecretStore {
  constructor(private readonly db: Db) {}

  set(projectSlug: string | null, key: string, valueEnc: string, masked: boolean): void {
    this.db
      .prepare(
        `INSERT INTO secret (project_slug, key, value_enc, masked, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_slug, key) DO UPDATE
           SET value_enc = excluded.value_enc,
               masked = excluded.masked,
               updated_at = excluded.updated_at`,
      )
      .run(projectSlug ?? GLOBAL, key, valueEnc, masked ? 1 : 0, new Date().toISOString());
  }

  /** Rows that apply to a project, project scope winning over global. */
  private applicable(projectSlug: string): Row[] {
    const rows = this.db
      .prepare("SELECT * FROM secret WHERE project_slug IN (?, ?) ORDER BY key")
      .all(projectSlug, GLOBAL) as Row[];

    const byKey = new Map<string, Row>();
    for (const row of rows) {
      const existing = byKey.get(row.key);
      if (!existing || row.project_slug !== GLOBAL) byKey.set(row.key, row);
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  list(projectSlug: string): SecretSummary[] {
    return this.applicable(projectSlug).map((row) => ({
      key: row.key,
      masked: row.masked === 1,
      scope: row.project_slug === GLOBAL ? "global" : "project",
    }));
  }

  listGlobal(): SecretSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM secret WHERE project_slug = ? ORDER BY key")
      .all(GLOBAL) as Row[];
    return rows.map((row) => ({ key: row.key, masked: row.masked === 1, scope: "global" as const }));
  }

  /** Ciphertext by name, for the vault to decrypt. */
  encrypted(projectSlug: string): Record<string, string> {
    return Object.fromEntries(this.applicable(projectSlug).map((row) => [row.key, row.value_enc]));
  }

  /** Which of the applicable secrets should be kept out of the logs. */
  maskedKeys(projectSlug: string): Set<string> {
    return new Set(this.applicable(projectSlug).filter((r) => r.masked === 1).map((r) => r.key));
  }

  remove(projectSlug: string | null, key: string): boolean {
    const res = this.db
      .prepare("DELETE FROM secret WHERE project_slug = ? AND key = ?")
      .run(projectSlug ?? GLOBAL, key);
    return res.changes > 0;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/db/secrets.test.ts`
Expected: 6 passing.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/secrets.ts tests/db/secrets.test.ts
git commit -m "feat(db): secret table, ciphertext only, project scope wins"
```

---

### Task 4: The redactor

The heart of the milestone. Everything else is plumbing.

**Files:**
- Create: `src/logs/redact.ts`, `tests/logs/redact.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/logs/redact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/logs/redact.js";

/** Feeds a string one byte at a time — the worst case a PTY can produce. */
function throughOneByteAtATime(redactor: Redactor, text: string): string {
  let out = "";
  for (const char of text) out += redactor.push(char);
  return out + redactor.flush();
}

describe("Redactor", () => {
  it("replaces a secret with a marker", () => {
    const r = new Redactor(["hunter2"]);
    expect(r.push("password is hunter2 ok") + r.flush()).toBe("password is •••••• ok");
  });

  it("catches a secret split across chunks", () => {
    const r = new Redactor(["hunter2"]);
    const out = r.push("password is hun") + r.push("ter2 ok") + r.flush();
    expect(out).toBe("password is •••••• ok");
  });

  it("catches a secret split one character at a time", () => {
    const r = new Redactor(["s3cr3t-value"]);
    expect(throughOneByteAtATime(r, "token=s3cr3t-value done")).toBe("token=•••••• done");
  });

  it("never emits a prefix of a secret before it knows", () => {
    const r = new Redactor(["hunter2"]);
    // "hunte" could still become "hunter2": nothing that far may be released yet.
    expect(r.push("hunte")).toBe("");
  });

  it("releases text that can no longer match", () => {
    const r = new Redactor(["hunter2"]);
    expect(r.push("hunta")).toBe("hunta");
  });

  it("redacts every occurrence, not just the first", () => {
    const r = new Redactor(["abc"]);
    expect(r.push("abc and abc") + r.flush()).toBe("•••••• and ••••••");
  });

  it("handles several secrets, longest first so one cannot leak inside another", () => {
    const r = new Redactor(["token", "token-suffix"]);
    expect(r.push("value=token-suffix") + r.flush()).toBe("value=••••••");
  });

  it("ignores values too short to redact safely", () => {
    // Redacting "a" would eat the log alive and hide nothing useful.
    const r = new Redactor(["a", "ok"]);
    expect(r.push("a ok banana") + r.flush()).toBe("a ok banana");
  });

  it("passes text through untouched when there is nothing to hide", () => {
    const r = new Redactor([]);
    expect(r.push("nothing to do here") + r.flush()).toBe("nothing to do here");
  });

  it("flushes whatever is still held back", () => {
    const r = new Redactor(["hunter2"]);
    r.push("ends with hunte");
    expect(r.flush()).toBe("ends with hunte");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- tests/logs/redact.test.ts`
Expected: failure, module not found.

- [ ] **Step 3: Implement**

`src/logs/redact.ts`:

```ts
/** What a redacted value is replaced with. Fixed width, so it leaks no length. */
const MARKER = "••••••";

/**
 * Values shorter than this are left alone.
 *
 * A two-character secret would match constantly and turn the log into confetti
 * while hiding nothing an attacker could not guess. Refusing is more honest than
 * pretending to protect it.
 */
const MIN_LENGTH = 4;

/**
 * Removes secret values from a stream of text.
 *
 * The difficulty is not the replacement, it is the boundaries: a pseudo-terminal
 * cuts its output wherever it likes, so a secret can arrive as `hun` then `ter2`.
 * Replacing chunk by chunk would let it through in two pieces — and the file on
 * disk would contain it in full.
 *
 * So the redactor holds back the last few characters, exactly as many as could
 * still turn out to be the beginning of a secret, and releases them only once
 * they cannot. `flush()` empties that buffer at the end of the run.
 */
export class Redactor {
  private readonly values: string[];
  private readonly longest: number;
  private held = "";

  constructor(values: string[]) {
    // Longest first: replacing "token" before "token-suffix" would leave the
    // suffix behind in the log.
    this.values = [...new Set(values.filter((v) => v.length >= MIN_LENGTH))].sort(
      (a, b) => b.length - a.length,
    );
    this.longest = this.values.reduce((max, v) => Math.max(max, v.length), 0);
  }

  private replaceAll(text: string): string {
    let out = text;
    for (const value of this.values) out = out.split(value).join(MARKER);
    return out;
  }

  /** Takes a chunk, returns the part that is safe to write out. */
  push(chunk: string): string {
    if (this.values.length === 0) return chunk;

    const combined = this.replaceAll(this.held + chunk);

    // Keep back the tail that could still be the start of a secret. One
    // character less than the longest value is always enough, and cheap.
    const keep = Math.min(this.longest - 1, combined.length);
    this.held = combined.slice(combined.length - keep);
    return combined.slice(0, combined.length - keep);
  }

  /** Releases the tail. Call once, when the stream is over. */
  flush(): string {
    const rest = this.replaceAll(this.held);
    this.held = "";
    return rest;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/logs/redact.test.ts`
Expected: 10 passing.

- [ ] **Step 5: Commit**

```bash
git add src/logs/redact.ts tests/logs/redact.test.ts
git commit -m "feat(logs): redactor that survives chunk boundaries"
```

---

### Task 5: The vault

The single place where plaintext exists.

**Files:**
- Create: `src/secrets/vault.ts`, `tests/secrets/vault.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/secrets/vault.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { tmpDir } from "../fixtures/repos.js";

async function vault() {
  const db = openDatabase(":memory:");
  return { vault: await Vault.open(await tmpDir("laneyard-vault-"), new SecretStore(db)), db };
}

describe("Vault", () => {
  it("round-trips a value through storage", async () => {
    const { vault: v } = await vault();
    await v.set("app", "TOKEN", "hunter2", true);
    expect(v.resolve("app")).toEqual({ TOKEN: "hunter2" });
  });

  it("stores ciphertext, never the value", async () => {
    const { vault: v, db } = await vault();
    await v.set("app", "TOKEN", "hunter2", true);

    const stored = db.prepare("SELECT value_enc FROM secret").get() as { value_enc: string };
    expect(stored.value_enc).not.toContain("hunter2");
    expect(stored.value_enc.startsWith("v1.")).toBe(true);
  });

  it("returns only the values worth hiding from a log", async () => {
    const { vault: v } = await vault();
    await v.set("app", "SECRET", "hide-me", true);
    await v.set("app", "PUBLIC", "keep-me", false);

    expect(v.maskedValues("app").sort()).toEqual(["hide-me"]);
  });

  it("survives a secret it can no longer decrypt", async () => {
    const { vault: v, db } = await vault();
    await v.set("app", "GOOD", "fine", true);
    db.prepare("INSERT INTO secret (project_slug, key, value_enc, masked, updated_at) VALUES (?,?,?,?,?)")
      .run("app", "BROKEN", "v1.aaaa.bbbb.cccc", 1, new Date().toISOString());

    // One unreadable row must not take the whole run down with it.
    const resolved = v.resolve("app");
    expect(resolved["GOOD"]).toBe("fine");
    expect(resolved["BROKEN"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- tests/secrets/vault.test.ts`
Expected: failure, module not found.

- [ ] **Step 3: Implement**

`src/secrets/vault.ts`:

```ts
import type { SecretStore, SecretSummary } from "../db/secrets.js";
import { decrypt, encrypt } from "./cipher.js";
import { loadOrCreateKey } from "./key.js";

/**
 * The only component that ever holds a decrypted secret.
 *
 * Everything else — the store, the API, the interface — deals in names and
 * ciphertext. Keeping plaintext to one small file is what makes "a secret never
 * reaches a log" a claim you can check by reading, rather than a hope.
 */
export class Vault {
  private constructor(
    private readonly key: Buffer,
    private readonly store: SecretStore,
  ) {}

  static async open(home: string, store: SecretStore): Promise<Vault> {
    return new Vault(await loadOrCreateKey(home), store);
  }

  async set(projectSlug: string | null, key: string, value: string, masked: boolean): Promise<void> {
    this.store.set(projectSlug, key, encrypt(value, this.key), masked);
  }

  remove(projectSlug: string | null, key: string): boolean {
    return this.store.remove(projectSlug, key);
  }

  list(projectSlug: string): SecretSummary[] {
    return this.store.list(projectSlug);
  }

  /**
   * Every secret that applies to a project, ready to become environment variables.
   *
   * A row that will not decrypt is skipped rather than thrown: a key that was
   * rotated or a corrupted row should cost one variable, not the whole build.
   * The run then fails on its own terms, with fastlane saying what was missing.
   */
  resolve(projectSlug: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, payload] of Object.entries(this.store.encrypted(projectSlug))) {
      try {
        out[key] = decrypt(payload, this.key);
      } catch {
        // Deliberately silent here; the interface reports unreadable secrets.
      }
    }
    return out;
  }

  /** The values a run's output must not contain. */
  maskedValues(projectSlug: string): string[] {
    const masked = this.store.maskedKeys(projectSlug);
    return Object.entries(this.resolve(projectSlug))
      .filter(([key]) => masked.has(key))
      .map(([, value]) => value);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/secrets/vault.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/secrets/vault.ts tests/secrets/vault.test.ts
git commit -m "feat(secrets): the vault, sole holder of plaintext"
```

---

### Task 6: Wire the runner

**Files:**
- Modify: `src/runner/orchestrate.ts`
- Modify: `tests/runner/orchestrate.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/runner/orchestrate.test.ts`, and extend the existing `harness` to accept secrets.
The fake fastlane must print the secret so the test proves it was both injected and redacted:

```ts
  it("injects secrets into the run and keeps them out of the log", async () => {
    const origin = await makeOriginRepo({
      "fastlane/Fastfile": "lane :beta do\nend\n",
      ".gitignore": "build/\n",
    });
    const root = await tmpDir("laneyard-root-");
    const db = openDatabase(":memory:");
    const runs = new RunStore(db);
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    await executeRun({
      runId,
      runs,
      logs,
      workspacePath: join(root, "workspaces", "p"),
      artifactsDir: join(root, "artifacts", String(runId)),
      gitUrl: origin,
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: {
        PATH: `${FAKE_DIR}:${process.env["PATH"]}`,
        FAKE_FASTLANE_SCENARIO: "success",
        // The fixture echoes this variable, standing in for a lane that prints
        // a credential by accident — which is exactly how they escape in real life.
        FAKE_FASTLANE_ECHO: "MATCH_PASSWORD",
      },
      secrets: { MATCH_PASSWORD: "s3cr3t-value" },
      maskedValues: ["s3cr3t-value"],
      onChunk: () => {},
    });

    const log = await logs.read(runId);
    expect(log).toContain("MATCH_PASSWORD=");
    expect(log).not.toContain("s3cr3t-value");
    expect(log).toContain("••••••");
  }, 60_000);

  it("keeps the secret out of what the browser receives too", async () => {
    // Redaction happens before the fan-out, so the file and the socket cannot
    // disagree — a fix applied to only one of them would be worse than none.
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n", ".gitignore": "build/\n" });
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    const broadcast: string[] = [];
    await executeRun({
      runId, runs, logs,
      workspacePath: join(root, "workspaces", "p"),
      artifactsDir: join(root, "artifacts", String(runId)),
      gitUrl: origin,
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: {
        PATH: `${FAKE_DIR}:${process.env["PATH"]}`,
        FAKE_FASTLANE_SCENARIO: "success",
        FAKE_FASTLANE_ECHO: "MATCH_PASSWORD",
      },
      secrets: { MATCH_PASSWORD: "s3cr3t-value" },
      maskedValues: ["s3cr3t-value"],
      onChunk: (chunk) => broadcast.push(chunk),
    });

    expect(broadcast.join("")).not.toContain("s3cr3t-value");
  }, 60_000);
```

Extend the fixture `tests/fixtures/fake-fastlane/fastlane`, after the existing step lines:

```bash
# Stands in for a lane that prints a credential — the usual way secrets escape.
if [ -n "${FAKE_FASTLANE_ECHO:-}" ]; then
  eval "value=\${$FAKE_FASTLANE_ECHO:-}"
  echo "[09:41:06]: $FAKE_FASTLANE_ECHO=$value"
fi
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- tests/runner/orchestrate.test.ts`
Expected: failure — `secrets` is not a known option, and the secret appears in the log.

- [ ] **Step 3: Wire it in**

In `src/runner/orchestrate.ts`, add to `ExecuteRunOptions`:

```ts
  /** Resolved secrets, added to the run's environment. */
  secrets?: Record<string, string>;
  /** The values that must not appear in the log or in the browser. */
  maskedValues?: string[];
```

Import the redactor and apply it inside `emit`, before anything else happens to the text:

```ts
import { Redactor } from "../logs/redact.js";
```

```ts
  const redactor = new Redactor(opts.maskedValues ?? []);

  // Redaction happens here and nowhere else: this is the single point through
  // which every byte of output passes on its way to the file, the step tracker
  // and the browser. Filtering further downstream would mean filtering three
  // times, and forgetting one of them eventually.
  const emit = async (text: string): Promise<void> => {
    const safe = redactor.push(text);
    if (safe === "") return;
    const offset = await writer.append(safe);
    tracker.consume(safe, offset);
    opts.onChunk(safe, offset);
  };

  const emitRest = async (): Promise<void> => {
    const rest = redactor.flush();
    if (rest === "") return;
    const offset = await writer.append(rest);
    tracker.consume(rest, offset);
    opts.onChunk(rest, offset);
  };
```

Call `await emitRest()` immediately after `const outcome = await done;` and before
`await writer.close()`, and also inside `fail()` before closing the writer.

Add the secrets to the child environment:

```ts
    env: {
      ...opts.env,
      ...(opts.secrets ?? {}),
      CI: "true",
```

> Order matters: secrets come after `opts.env` so a stored secret wins over a
> variable that happens to exist in the server's own environment, and before the
> three fixed variables so no secret can override `CI`.

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/runner/orchestrate.test.ts`
Expected: all passing, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/runner/orchestrate.ts tests/runner/orchestrate.test.ts tests/fixtures/fake-fastlane/fastlane
git commit -m "feat(runner): inject secrets and redact them at the single fan-out point"
```

---

### Task 7: The API

**Files:**
- Create: `src/server/routes/secrets.ts`, `tests/server/secrets.test.ts`
- Modify: `src/server/app.ts` (build the vault, register the routes)
- Modify: `src/server/routes/runs.ts` (pass secrets to `executeRun`)

- [ ] **Step 1: Write the failing tests**

`tests/server/secrets.test.ts` — reuse the harness pattern from `tests/server/api.test.ts`:

```ts
describe("secrets API", () => {
  it("refuses without a session", …);            // 401
  it("lists names and scopes, never values", …); // no ciphertext, no plaintext in the body
  it("stores a secret and lists it", …);         // PUT then GET
  it("rejects a key that is not a valid environment variable name", …); // 400 on "not-a-key"
  it("overwrites an existing secret", …);
  it("deletes a secret", …);                     // DELETE then absent from GET
  it("404s on deleting one that does not exist", …);
  it("keeps global secrets on their own route", …);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- tests/server/secrets.test.ts`

- [ ] **Step 3: Implement**

`src/server/routes/secrets.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";

/** POSIX environment variable names. Anything else would never reach fastlane. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function registerSecretRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const listRoute = (slug: string | null) =>
    slug === null ? ctx.vault.listGlobal() : ctx.vault.list(slug);

  app.get("/api/secrets", async () => listRoute(null));

  app.get("/api/projects/:slug/secrets", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return listRoute(slug);
  });

  const put = async (slug: string | null, key: string, body: unknown, reply: any) => {
    const { value, masked } = (body ?? {}) as { value?: string; masked?: boolean };
    if (!VALID_KEY.test(key)) {
      return reply.code(400).send({
        error: `"${key}" is not a valid environment variable name: letters, digits and underscore, not starting with a digit.`,
      });
    }
    if (typeof value !== "string" || value === "") {
      return reply.code(400).send({ error: "A value is required" });
    }
    await ctx.vault.set(slug, key, value, masked !== false);
    return reply.code(204).send();
  };

  app.put("/api/secrets/:key", async (req, reply) =>
    put(null, (req.params as { key: string }).key, req.body, reply),
  );

  app.put("/api/projects/:slug/secrets/:key", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return put(slug, key, req.body, reply);
  });

  app.delete("/api/secrets/:key", async (req, reply) => {
    const removed = ctx.vault.remove(null, (req.params as { key: string }).key);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Unknown secret" });
  });

  app.delete("/api/projects/:slug/secrets/:key", async (req, reply) => {
    const { slug, key } = req.params as { slug: string; key: string };
    const removed = ctx.vault.remove(slug, key);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Unknown secret" });
  });
}
```

In `src/server/app.ts`: add `vault: Vault` to `AppDeps` and `AppContext`, and register the routes
alongside the others. `Vault.open` is async, so it is built in `createServerFromConfig`
(Task 8) and passed in — `buildApp` stays synchronous in spirit and the tests can inject a vault
built on a temporary directory.

In `src/server/routes/runs.ts`, pass the resolved secrets:

```ts
      secrets: ctx.vault.resolve(slug),
      maskedValues: ctx.vault.maskedValues(slug),
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/server/`

- [ ] **Step 5: Commit**

```bash
git add src/server tests/server/secrets.test.ts
git commit -m "feat(server): secrets API, names out, values only in"
```

---

### Task 8: Assemble

**Files:**
- Modify: `src/main.ts`, `tests/main.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("creates the vault key on first start", async () => {
    // …createServerFromConfig on an empty home, then:
    const info = await stat(join(root, "key"));
    expect(info.mode & 0o077).toBe(0);
  });
```

- [ ] **Step 2: Run it to see it fail**

- [ ] **Step 3: Build the vault in `createServerFromConfig`**

```ts
  const vault = await Vault.open(root, new SecretStore(db));
  const app = await buildApp({ config, db, root, vault, lanes: … });
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/main.test.ts
git commit -m "feat: open the vault at startup"
```

---

### Task 9: `laneyard secret set`

Typing a password into a web form is fine; pasting one into a terminal that keeps history is not.
This reads the value from stdin.

**Files:**
- Create: `src/cli/secret.ts`, `tests/cli/secret.test.ts`
- Modify: `src/main.ts` (dispatch), `README.md` (document it)

- [ ] **Step 1: Write the failing tests**

Cover: reading a value from stdin, refusing an invalid key name, `--project <slug>` versus global,
and that the value never appears in what the command prints.

- [ ] **Step 2 to 4: implement, run, verify**

```
laneyard secret set MATCH_PASSWORD --project app     # reads the value from stdin
echo "$TOKEN" | laneyard secret set GITHUB_TOKEN     # global, no shell history
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/secret.ts tests/cli/secret.test.ts src/main.ts README.md
git commit -m "feat(cli): laneyard secret set, value read from stdin"
```

---

### Task 10: The Secrets tab

**Files:**
- Create: `web/src/pages/Secrets.tsx`
- Modify: `web/src/api.ts`, `web/src/App.tsx`, `web/src/pages/Project.tsx`

- [ ] **Step 1: Extend the API client**

`secrets(slug)`, `setSecret(slug, key, value, masked)`, `deleteSecret(slug, key)`.

- [ ] **Step 2: Build the screen**

The same status-line grammar as the rest of the interface: one line per secret — marker, name,
right-aligned scope. A masked secret shows `••••••` where a value would be; there is no reveal
button, because the server cannot serve what it does not send.

A global secret shown on a project's tab is marked as such and is not editable from there: it
belongs to every project, and editing it from inside one would hide that fact.

The form is a name, a value, and a checkbox — *keep this out of the logs* — on by default.

- [ ] **Step 3: Verify by hand**

Start the server, add a secret through the interface, run a lane that prints it, and confirm the
terminal shows `••••••` while the build still succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat(web): secrets tab"
```

---

### Task 11: Tell the truth in the README

**Files:**
- Modify: `README.md`, and the landing page in the sibling repository

The security section currently says there is no vault and that logs are not redacted. Once this
milestone lands that is false, and a stale warning is as bad as a missing one.

- [ ] **Step 1: Rewrite the security section**

State what is now true: secrets are encrypted at rest with a key stored outside the database and
readable only by their owner; masked values are removed from output before it is written or sent,
not when it is displayed; and what remains true — this is built for a local network, not the
internet.

- [ ] **Step 2: Move the roadmap line**

`▸ encrypted secret vault and log redaction` becomes `✓`, in the README and on the landing page.
Both. They are separate repositories and nothing enforces that they agree.

- [ ] **Step 3: Commit both repositories**

---

## What this milestone still does not do

- Rotating the vault key. If the key is lost, every secret must be entered again; the payload
  version prefix is there so rotation can be added without guessing at old rows.
- Redacting secrets from a log that was written *before* they were stored. Redaction happens as
  output is produced; earlier runs keep whatever they captured.
- Secrets in `config.yml` via `$NAME`. The schema accepts the syntax; nothing resolves it yet.

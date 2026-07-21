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
    // Four characters minimum: below that the redactor declines, on purpose.
    const r = new Redactor(["abcd"]);
    expect(r.push("abcd and abcd") + r.flush()).toBe("•••••• and ••••••");
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

  it("releases everything once the stream ends", () => {
    const r = new Redactor(["hunter2"]);
    // `push` legitimately emits what is unambiguous; `flush` releases the rest.
    expect(r.push("ends with hunte") + r.flush()).toBe("ends with hunte");
  });

  it("survives splits at every position, for any secret", () => {
    // The property the whole design rests on. A fixed pair of splits would miss
    // an off-by-one; this walks every boundary there is.
    const secret = "s3cr3t-value-9";
    const text = `before ${secret} between ${secret} after`;

    for (let cut = 0; cut <= text.length; cut += 1) {
      const r = new Redactor([secret]);
      const out = r.push(text.slice(0, cut)) + r.push(text.slice(cut)) + r.flush();
      expect(out).not.toContain(secret);
      expect(out).toBe("before •••••• between •••••• after");
    }
  });
});

describe("Redactor under adversarial chunking", () => {
  /**
   * Deterministic pseudo-random source.
   *
   * A fuzz test that changes every run is a fuzz test that fails on someone
   * else's machine and passes on yours. The seed is fixed so a failure is
   * reproducible; change it deliberately if you want a different sample.
   */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it("never lets a secret through, whatever the chunking", () => {
    const next = random(20260721);
    const pick = (s: string) => s[Math.floor(next() * s.length)]!;
    const ALPHABET = "abc-_0";

    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const secrets = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
        Array.from({ length: 4 + Math.floor(next() * 6) }, () => pick(ALPHABET)).join(""),
      );

      let text = "";
      for (let piece = 0; piece < 1 + Math.floor(next() * 6); piece += 1) {
        text += Array.from({ length: Math.floor(next() * 8) }, () => pick(ALPHABET)).join("");
        if (next() < 0.5) text += secrets[Math.floor(next() * secrets.length)]!;
      }

      const redactor = new Redactor(secrets);
      let emitted = "";
      for (let pos = 0; pos < text.length; ) {
        const take = 1 + Math.floor(next() * 5);
        emitted += redactor.push(text.slice(pos, pos + take));
        pos += take;
      }
      // Checked before the flush as well: a secret released early is already lost.
      for (const secret of secrets) expect(emitted).not.toContain(secret);

      const full = emitted + redactor.flush();
      for (const secret of secrets) expect(full).not.toContain(secret);
    }
  });

  it("leaves text alone when it contains no secret", () => {
    const r = new Redactor(["s3cr3t-value"]);
    const innocent = "a perfectly ordinary line of build output\n";
    expect(r.push(innocent) + r.flush()).toBe(innocent);
  });
});

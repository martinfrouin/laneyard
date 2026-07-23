# Fastfile adoption at setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `laneyard setup` finds credentials named by literal values in a Fastfile, lifts them into this machine's vault, and offers a byte-exact patch replacing the literal with `ENV.fetch(...)` — an offer that can be declined without breaking anything.

**Architecture:** A new Prism-only Ruby script reports *every* literal keyword argument of every call with its byte ranges, and knows nothing about credentials. All credential knowledge stays in TypeScript, in one rule table beside `credentials/kinds.ts`. A pure splice function applies accepted proposals to the source. Setup runs this as a second act, after the project is already registered.

**Tech Stack:** Ruby + Prism (parsing), TypeScript + Node 22, vitest, better-sqlite3 via the existing `Vault`.

**Spec:** `docs/superpowers/specs/2026-07-23-fastfile-adoption-design.md`

---

## Why the Ruby is dumb

The spec says the scan emits findings tagged by tier. Reading `introspect.rb`
changed that: `literal_args` and `arg_names` already walk keyword arguments, and
a rule table in Ruby would be a second copy of the one in
`src/credentials/kinds.ts` — free to disagree with it, in a language where it
cannot be typechecked against it.

So `scan.rb` reports **every keyword argument with a literal string value, with
its byte ranges**, and has no idea what a credential is. All three tiers are
pure TypeScript filtering over that list. Ruby answers "what does this file
say"; TypeScript answers "what does that mean".

## File structure

| File | Responsibility |
|---|---|
| `ruby/scan.rb` **(new)** | Prism-only. Every call's literal keyword args, with byte ranges. Never requires fastlane. |
| `src/sidecar/bridge.ts` **(modify)** | `resolveSidecarScript` takes a filename instead of hardcoding `introspect.rb`. |
| `src/sidecar/prism-ruby.ts` **(new)** | Finds a Ruby that can `require "prism"`. Memoized. Returns null rather than throwing. |
| `src/sidecar/scan.ts` **(new)** | Runs `scan.rb` under that Ruby, parses the JSON, returns `Literal[]` or null. |
| `src/fastfile/adoption.ts` **(new)** | The rule table. `Literal[] → Proposal[]`. Pure, no I/O. |
| `src/fastfile/splice.ts` **(new)** | `(source, edits) => source`. Pure, byte-exact. |
| `src/cli/adopt.ts` **(new)** | The second act of setup: shows proposals, asks, writes vault then Fastfile. |
| `src/cli/setup.ts` **(modify)** | Calls `runAdoption` after the success block. Gains `home` in `SetupOptions`. |
| `src/main.ts` **(modify)** | Passes `home` through. |

`ruby/scan.rb` is a separate script rather than a command inside
`introspect.rb` for two reasons. `introspect.rb` requires fastlane
unconditionally before it dispatches, so a command inside it would pay a
fastlane boot the scan does not need. And `sidecarVersion()` hashes that script
into the introspection cache key — every edit to a `scan` command would throw
away every project's cached lane reading on upgrade.

---

## Task 1: `resolveSidecarScript` takes a filename

**Files:**
- Modify: `src/sidecar/bridge.ts:17-30`
- Test: `tests/sidecar/bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("resolves a named sidecar script in both layouts", () => {
  // `src/sidecar/` sits two levels under the package root.
  const fromSource = resolveSidecarScript(join(process.cwd(), "src", "sidecar"), "scan.rb");
  expect(fromSource).toBe(join(process.cwd(), "ruby", "scan.rb"));
});

it("still defaults to introspect.rb", () => {
  const path = resolveSidecarScript(join(process.cwd(), "src", "sidecar"));
  expect(path.endsWith(join("ruby", "introspect.rb"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sidecar/bridge.test.ts -t "named sidecar script"`
Expected: FAIL — `resolveSidecarScript` takes one argument.

- [ ] **Step 3: Write minimal implementation**

In `src/sidecar/bridge.ts`, change the signature and the candidates:

```ts
export function resolveSidecarScript(moduleDir: string, file = "introspect.rb"): string {
  const candidates = [
    join(moduleDir, "..", "..", "ruby", file),
    join(moduleDir, "..", "..", "..", "ruby", file),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
```

The existing `const SCRIPT = resolveSidecarScript(...)` call is unchanged — the
default keeps it working.

- [ ] **Step 4: Run the whole sidecar suite**

Run: `npx vitest run tests/sidecar`
Expected: PASS, including the existing `bridge.test.ts` cases.

- [ ] **Step 5: Commit**

```bash
git add src/sidecar/bridge.ts tests/sidecar/bridge.test.ts
git commit -m "Let resolveSidecarScript name its script"
```

---

## Task 2: `ruby/scan.rb`

**Files:**
- Create: `ruby/scan.rb`
- Test: `tests/ruby/scan.test.ts`

Note `package.json`'s `files` array already ships the whole `ruby/` folder, so
nothing needs adding there.

- [ ] **Step 1: Write the failing test**

Create `tests/ruby/scan.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../fixtures/repos.js";

const exec = promisify(execFile);
const SCRIPT = join(process.cwd(), "ruby", "scan.rb");

async function projectWithFastfile(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-scan-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  await writeFile(join(dir, "fastlane", "Fastfile"), content, "utf8");
  return dir;
}

/** No fastlane environment: that is the point of this script. */
async function scan(dir: string): Promise<any> {
  const { stdout } = await exec("ruby", [SCRIPT, "--fastlane-dir", "fastlane"], {
    cwd: dir,
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

describe("scan.rb", () => {
  it("reports a literal keyword argument with byte ranges", async () => {
    const source = `lane :beta do\n  app_store_connect_api_key(key_filepath: "./AuthKey_9K2LM4XY.p8")\nend\n`;
    const dir = await projectWithFastfile(source);

    const res = await scan(dir);
    expect(res.ok).toBe(true);
    expect(res.literals).toHaveLength(1);

    const [found] = res.literals;
    expect(found.action).toBe("app_store_connect_api_key");
    expect(found.arg).toBe("key_filepath");
    expect(found.value).toBe("./AuthKey_9K2LM4XY.p8");

    // The value range covers the literal including its quotes.
    expect(source.slice(found.value_start, found.value_start + found.value_length))
      .toBe('"./AuthKey_9K2LM4XY.p8"');
    // The pair range covers `key: value`.
    expect(source.slice(found.pair_start, found.pair_start + found.pair_length))
      .toBe('key_filepath: "./AuthKey_9K2LM4XY.p8"');
  });

  it("ignores a keyword whose value is not a literal string", async () => {
    const dir = await projectWithFastfile(
      `lane :beta do\n  supply(json_key: ENV.fetch("SUPPLY_JSON_KEY"))\nend\n`,
    );
    expect((await scan(dir)).literals).toEqual([]);
  });

  it("ignores text inside a comment", async () => {
    const dir = await projectWithFastfile(
      `lane :beta do\n  # supply(json_key: "./play.json")\n  build_app\nend\n`,
    );
    expect((await scan(dir)).literals).toEqual([]);
  });

  it("reports a Fastfile that does not parse as an error, not a crash", async () => {
    const dir = await projectWithFastfile(`lane :beta do\n  build_app(\nend\n`);
    const res = await scan(dir);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not be parsed/i);
  });

  it("finds literals in a method the Fastfile defines, not only in lanes", async () => {
    const dir = await projectWithFastfile(
      `def ship\n  supply(json_key: "./play.json")\nend\nlane :beta do\n  ship\nend\n`,
    );
    const res = await scan(dir);
    expect(res.literals.map((l: any) => l.arg)).toEqual(["json_key"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ruby/scan.test.ts`
Expected: FAIL — `ruby/scan.rb` does not exist (ENOENT).

- [ ] **Step 3: Write the script**

Create `ruby/scan.rb`:

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Laneyard's Fastfile scanner.
#
#   ruby scan.rb --fastlane-dir fastlane
#
# Deliberately ignorant. It reports every keyword argument whose value is a
# literal string, with the byte ranges of the value and of the whole
# `key: value` pair, and has no idea what a credential is. Deciding which of
# those matters is `src/fastfile/adoption.ts`'s job, next to the one table that
# already describes each credential kind — a second copy of that table here
# would be free to disagree with it, in a language that cannot check it.
#
# It never requires fastlane. `introspect.rb` must, to enumerate lanes; a
# syntax tree needs only Prism, and paying a fastlane boot for it would make
# this too slow to run during `laneyard setup`.
#
# The output contract is `introspect.rb`'s: { "ok": true, ... } or
# { "ok": false, "error": "..." }. An error is a valid response.

require "json"

REAL_STDOUT = $stdout.dup

def respond(payload)
  REAL_STDOUT.puts JSON.generate(payload)
  REAL_STDOUT.flush
  exit 0
end

def fail_with(message)
  respond({ ok: false, error: message.to_s })
end

dir_index = ARGV.index("--fastlane-dir")
fastlane_dir = dir_index ? ARGV[dir_index + 1] : "fastlane"
fastfile_path = File.join(Dir.pwd, fastlane_dir, "Fastfile")

fail_with("Fastfile not found: #{fastfile_path}") unless File.exist?(fastfile_path)

# Anything the parser writes must not reach the real output, which carries JSON
# and nothing else.
$stdout = $stderr

begin
  require "prism"
rescue LoadError => e
  fail_with("prism is not available in this Ruby (#{e.message})")
end

# Every `key: "literal"` inside a call, wherever the call sits.
#
# Descends through everything: a call inside an `if`, inside a `def`, inside a
# `platform` block, is still a call this file makes. `calls_within` in
# introspect.rb resolves helper methods to attribute actions to a *lane*; there
# is no such need here, because a literal path is a problem wherever it is
# written and belongs to the file rather than to any one lane.
def literals_in(node, source, out = [])
  return out if node.nil?

  node.compact_child_nodes.each do |child|
    if child.is_a?(Prism::CallNode)
      hash = (child.arguments&.arguments || []).find { |a| a.is_a?(Prism::KeywordHashNode) }
      hash&.elements&.each do |el|
        next unless el.is_a?(Prism::AssocNode)
        next unless el.key.is_a?(Prism::SymbolNode)
        next unless el.value.is_a?(Prism::StringNode)

        out << {
          action: child.name.to_s,
          arg: el.key.unescaped,
          value: el.value.unescaped,
          value_start: el.value.location.start_offset,
          value_length: el.value.location.length,
          pair_start: el.location.start_offset,
          pair_length: el.location.length,
          line: el.location.start_line
        }
      end
    end
    literals_in(child, source, out)
  end
  out
end

begin
  source = File.read(fastfile_path)
  result = Prism.parse(source)
  fail_with("Fastfile could not be parsed") unless result.success?
  literals = literals_in(result.value, source)
rescue Exception => e # rubocop:disable Lint/RescueException
  # Same shape as introspect.rb, and the same trap: `respond` ends in `exit 0`,
  # which raises SystemExit, so the success case must stay outside this rescue
  # or it writes a second JSON blob after the first.
  fail_with("Could not read the Fastfile: #{e.message}")
end

respond({ ok: true, literals: literals })
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/ruby/scan.test.ts`
Expected: PASS, all five cases.

If they fail with `prism is not available`, the `ruby` on `PATH` is macOS's
2.6 — Prism is a default gem only from Ruby 3.3. Run with a modern Ruby first
(`brew install ruby`); Task 3 is what makes this robust in production.

- [ ] **Step 5: Commit**

```bash
git add ruby/scan.rb tests/ruby/scan.test.ts
git commit -m "Add scan.rb: every literal keyword argument, with byte ranges"
```

---

## Task 3: finding a Ruby that has Prism

**Files:**
- Create: `src/sidecar/prism-ruby.ts`
- Test: `tests/sidecar/prism-ruby.test.ts`

Measured on macOS 25: `/usr/bin/ruby` is 2.6.10 and cannot load Prism; a
Homebrew Ruby beside it is 4.0.5 and can. Which one `PATH` points at when
someone runs `laneyard setup` is an accident, so this resolves rather than
assumes.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolvePrismRuby } from "../../src/sidecar/prism-ruby.js";

describe("resolvePrismRuby", () => {
  it("finds a Ruby that can require prism, or answers null", async () => {
    const env = await resolvePrismRuby();
    // Either answer is correct — what must never happen is a throw.
    expect(env === null || typeof env === "object").toBe(true);
  });

  it("memoizes, so setup pays the probe once", async () => {
    const a = resolvePrismRuby();
    const b = resolvePrismRuby();
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sidecar/prism-ruby.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveRubyEnv } from "./ruby-env.js";

const exec = promisify(execFile);

/**
 * An environment in which `ruby` can load Prism, or null.
 *
 * Two candidates, cheapest first. `process.env` is right whenever the user's
 * shell already points at a modern Ruby, and costs milliseconds. Only when
 * that fails is `resolveRubyEnv` asked — it probes `require "fastlane"` and is
 * slow, but it finds the Ruby the project actually builds with, which is the
 * one that matters when `PATH` points somewhere else.
 *
 * Measured, and the reason this function exists rather than a bare `ruby`:
 * macOS ships 2.6 at `/usr/bin/ruby`, and Prism is a default gem only from
 * Ruby 3.3. A caller that assumed `ruby` would do would silently never find
 * anything on a machine whose shell had not been set up.
 *
 * Returns null rather than throwing. Every caller treats an absent Ruby as
 * "not analysed", never as a failure.
 */
async function canRequirePrism(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await exec("ruby", ["-e", 'require "prism"'], { env, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

let cached: Promise<NodeJS.ProcessEnv | null> | null = null;

export function resolvePrismRuby(): Promise<NodeJS.ProcessEnv | null> {
  cached ??= (async () => {
    if (await canRequirePrism(process.env)) return process.env;

    const fallback = await resolveRubyEnv();
    if (fallback && (await canRequirePrism(fallback.env))) return fallback.env;

    return null;
  })();
  return cached;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/sidecar/prism-ruby.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidecar/prism-ruby.ts tests/sidecar/prism-ruby.test.ts
git commit -m "Resolve a Ruby that can load Prism, or answer null"
```

---

## Task 4: the scan invoker

**Files:**
- Create: `src/sidecar/scan.ts`
- Test: `tests/sidecar/scan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanFastfile } from "../../src/sidecar/scan.js";
import { tmpDir } from "../fixtures/repos.js";

async function projectWithFastfile(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-scanner-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  await writeFile(join(dir, "fastlane", "Fastfile"), content, "utf8");
  return dir;
}

describe("scanFastfile", () => {
  it("returns the literals a Fastfile holds", async () => {
    const dir = await projectWithFastfile(
      `lane :beta do\n  supply(json_key: "./play.json")\nend\n`,
    );
    const found = await scanFastfile(dir, "fastlane");
    expect(found?.map((l) => l.arg)).toEqual(["json_key"]);
  });

  it("answers null for a Fastfile that does not parse, rather than throwing", async () => {
    const dir = await projectWithFastfile(`lane :beta do\n  build_app(\nend\n`);
    await expect(scanFastfile(dir, "fastlane")).resolves.toBeNull();
  });

  it("answers null when the directory holds no Fastfile", async () => {
    const dir = await tmpDir("laneyard-scanner-");
    await expect(scanFastfile(dir, "fastlane")).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sidecar/scan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveSidecarScript } from "./bridge.js";
import { resolvePrismRuby } from "./prism-ruby.js";

const exec = promisify(execFile);

const SCRIPT = resolveSidecarScript(dirname(fileURLToPath(import.meta.url)), "scan.rb");

/** One keyword argument written as a literal string, and where it sits. */
export interface Literal {
  action: string;
  arg: string;
  value: string;
  /** Byte range of the literal itself, quotes included. */
  valueStart: number;
  valueLength: number;
  /** Byte range of the whole `key: value` pair. */
  pairStart: number;
  pairLength: number;
  line: number;
}

/**
 * What a Fastfile says, or null.
 *
 * **Null is an ordinary answer, never a failure.** No Ruby with Prism, no
 * Fastfile, a Fastfile that does not parse — all of them mean the same thing to
 * every caller: this file was not analysed, carry on. Setup must not fail
 * because a scan could not run; it did its job before this feature existed.
 */
export async function scanFastfile(cwd: string, fastlaneDir: string): Promise<Literal[] | null> {
  const env = await resolvePrismRuby();
  if (env === null) return null;

  try {
    const { stdout } = await exec("ruby", [SCRIPT, "--fastlane-dir", fastlaneDir], {
      cwd,
      env,
      timeout: 30_000,
    });
    const res = JSON.parse(stdout) as
      | { ok: true; literals: Record<string, unknown>[] }
      | { ok: false; error: string };
    if (!res.ok) return null;

    return res.literals.map((l) => ({
      action: String(l["action"]),
      arg: String(l["arg"]),
      value: String(l["value"]),
      valueStart: Number(l["value_start"]),
      valueLength: Number(l["value_length"]),
      pairStart: Number(l["pair_start"]),
      pairLength: Number(l["pair_length"]),
      line: Number(l["line"]),
    }));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/sidecar/scan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidecar/scan.ts tests/sidecar/scan.test.ts
git commit -m "Run scan.rb and read its literals, answering null on any doubt"
```

---

## Task 5: the splice

**Files:**
- Create: `src/fastfile/splice.ts`
- Test: `tests/fastfile/splice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { splice } from "../../src/fastfile/splice.js";

describe("splice", () => {
  it("replaces one range and leaves every other byte alone", () => {
    const source = `lane :beta do\n  supply(json_key: "./play.json")\nend\n`;
    const start = source.indexOf('"./play.json"');
    const out = splice(source, [
      { start, length: '"./play.json"'.length, replacement: 'ENV.fetch("SUPPLY_JSON_KEY")' },
    ]);
    expect(out).toBe(`lane :beta do\n  supply(json_key: ENV.fetch("SUPPLY_JSON_KEY"))\nend\n`);
  });

  it("applies several edits without letting earlier ones shift later ones", () => {
    const source = `a("one")\nb("two")\n`;
    const out = splice(source, [
      { start: source.indexOf('"one"'), length: 5, replacement: "X" },
      { start: source.indexOf('"two"'), length: 5, replacement: "YYYYYYYY" },
    ]);
    expect(out).toBe(`a(X)\nb(YYYYYYYY)\n`);
  });

  it("accepts edits in any order", () => {
    const source = `a("one")\nb("two")\n`;
    const forward = splice(source, [
      { start: source.indexOf('"one"'), length: 5, replacement: "X" },
      { start: source.indexOf('"two"'), length: 5, replacement: "Y" },
    ]);
    const reversed = splice(source, [
      { start: source.indexOf('"two"'), length: 5, replacement: "Y" },
      { start: source.indexOf('"one"'), length: 5, replacement: "X" },
    ]);
    expect(forward).toBe(reversed);
  });

  it("refuses overlapping edits rather than producing nonsense", () => {
    const source = `a("one")\n`;
    expect(() =>
      splice(source, [
        { start: 2, length: 5, replacement: "X" },
        { start: 4, length: 3, replacement: "Y" },
      ]),
    ).toThrow(/overlap/i);
  });

  it("returns the source untouched when there is nothing to do", () => {
    const source = `lane :beta do\nend\n`;
    expect(splice(source, [])).toBe(source);
  });

  it("counts in bytes, so a literal after an accented comment still lands right", () => {
    const source = `# déjà là\nsupply(json_key: "./play.json")\n`;
    const buf = Buffer.from(source, "utf8");
    const start = buf.indexOf(Buffer.from('"./play.json"', "utf8"));
    const out = splice(source, [{ start, length: 13, replacement: "X" }]);
    expect(out).toBe(`# déjà là\nsupply(json_key: X)\n`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fastfile/splice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Prism counts in bytes; JavaScript strings are counted in UTF-16 code units. A
Fastfile with an accented comment above a literal is ordinary, so the splice
works on a Buffer and converts once at each end.

```ts
/** One range of the source, and what replaces it. Offsets are in bytes. */
export interface Edit {
  start: number;
  length: number;
  replacement: string;
}

/**
 * Replaces ranges of a source, leaving every other byte exactly as it was.
 *
 * The same requirement `fastfile/store.ts` documents: a file written by hand
 * must never come back reformatted, reordered, or with its trailing newline
 * fixed. Someone may have spent a long time on that file.
 *
 * **Byte offsets, not string indices.** Prism reports positions in bytes, and
 * one accented character above the literal would put every later offset off by
 * one — a patch landing in the middle of a string, on a build file, silently.
 * So the work happens on a Buffer.
 *
 * Edits are applied last-first so an earlier replacement cannot shift the
 * offsets of the ones after it, and may be handed in in any order. Overlapping
 * edits throw: two rules that both claim the same bytes is a bug in the rule
 * table, and applying one of them arbitrarily would hide it.
 */
export function splice(source: string, edits: Edit[]): string {
  if (edits.length === 0) return source;

  const ordered = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    if (previous.start + previous.length > ordered[i]!.start) {
      throw new Error("edits overlap");
    }
  }

  let buffer = Buffer.from(source, "utf8");
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const edit = ordered[i]!;
    buffer = Buffer.concat([
      buffer.subarray(0, edit.start),
      Buffer.from(edit.replacement, "utf8"),
      buffer.subarray(edit.start + edit.length),
    ]);
  }
  return buffer.toString("utf8");
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/fastfile/splice.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add src/fastfile/splice.ts tests/fastfile/splice.test.ts
git commit -m "Add a byte-exact splice for Fastfile edits"
```

---

## Task 6: the rule table

**Files:**
- Create: `src/fastfile/adoption.ts`
- Test: `tests/fastfile/adoption.test.ts`

This is where every credential decision lives. It reads `credentials/kinds.ts`
for the variable names rather than repeating them.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { proposalsFor } from "../../src/fastfile/adoption.js";
import type { Literal } from "../../src/sidecar/scan.js";

const literal = (over: Partial<Literal>): Literal => ({
  action: "supply",
  arg: "json_key",
  value: "./play.json",
  valueStart: 10,
  valueLength: 13,
  pairStart: 0,
  pairLength: 23,
  line: 2,
  ...over,
});

describe("proposalsFor", () => {
  it("proposes a path swap for a play service account, checked by default", () => {
    const [p] = proposalsFor([literal({})]);
    expect(p!.tier).toBe("file");
    expect(p!.kind).toBe("play_service_account");
    expect(p!.checked).toBe(true);
    expect(p!.edit).toEqual({ start: 10, length: 13, replacement: 'ENV.fetch("SUPPLY_JSON_KEY")' });
  });

  it("uses the App Store Connect filepath name for a .p8", () => {
    const [p] = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_filepath", value: "./AuthKey_9K2LM4XY.p8" }),
    ]);
    expect(p!.kind).toBe("apple_asc");
    expect(p!.edit.replacement).toBe('ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")');
  });

  it("reads the Key ID out of the conventional filename", () => {
    const [p] = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_filepath", value: "keys/AuthKey_9K2LM4XY.p8" }),
    ]);
    expect(p!.suggestedFields).toEqual({ key_id: "9K2LM4XY" });
  });

  it("rewrites the whole pair for inline contents, not just the value", () => {
    const [p] = proposalsFor([
      literal({
        action: "app_store_connect_api_key",
        arg: "key_content",
        value: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        pairStart: 4,
        pairLength: 70,
      }),
    ]);
    expect(p!.tier).toBe("inline");
    expect(p!.edit.start).toBe(4);
    expect(p!.edit.length).toBe(70);
    expect(p!.edit.replacement).toBe('key_filepath: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")');
  });

  it("offers a literal secret unchecked, because a false positive is likely", () => {
    const [p] = proposalsFor([literal({ action: "pilot", arg: "api_token", value: "abc123" })]);
    expect(p!.tier).toBe("secret");
    expect(p!.checked).toBe(false);
  });

  it("ignores an empty literal", () => {
    expect(proposalsFor([literal({ action: "pilot", arg: "api_token", value: "" })])).toEqual([]);
  });

  it("ignores an argument nothing recognises", () => {
    expect(proposalsFor([literal({ action: "build_app", arg: "scheme", value: "Runner" })])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fastfile/adoption.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { defaultVarNames } from "../credentials/kinds.js";
import type { CredentialKind } from "../credentials/kinds.js";
import type { Edit } from "./splice.js";
import type { Literal } from "../sidecar/scan.js";

/**
 * How confident the scan is, which is what decides whether a proposal starts
 * ticked. Never a severity: an inline private key is worse than a hardcoded
 * path, and both are `checked` because both are certain.
 */
export type Tier = "file" | "inline" | "secret";

export interface Proposal {
  tier: Tier;
  /** The credential block this belongs in, absent for a plain vault entry. */
  kind?: CredentialKind;
  /** The vault entry name, for `secret` only. */
  varName: string;
  /** What the file said, for showing and for finding the file on disk. */
  literal: Literal;
  /** Fields the filename gave away, offered pre-filled at the prompt. */
  suggestedFields: Record<string, string>;
  edit: Edit;
  checked: boolean;
}

/** Which action arguments name a credential file, and which block they mean. */
const FILE_ARGS: { action: RegExp; arg: string; kind: CredentialKind }[] = [
  { action: /^app_store_connect_api_key$/, arg: "key_filepath", kind: "apple_asc" },
  { action: /^(supply|upload_to_play_store|validate_play_store_json_key)$/, arg: "json_key", kind: "play_service_account" },
];

/**
 * Arguments holding a credential's *contents* inline, and the argument they
 * must become.
 *
 * The rename is not cosmetic. `materialise.ts` stores a block as a file and
 * exports its *path*; there is no slot that exports contents. Replacing the
 * value alone would hand a filesystem path to an argument expecting PEM text,
 * and fastlane's complaint would point nowhere near here.
 */
const INLINE_ARGS: { action: RegExp; arg: string; becomes: string; kind: CredentialKind }[] = [
  { action: /^app_store_connect_api_key$/, arg: "key_content", becomes: "key_filepath", kind: "apple_asc" },
  { action: /^(supply|upload_to_play_store)$/, arg: "json_key_data", becomes: "json_key", kind: "play_service_account" },
];

/** What a literal secret looks like when nothing more specific matched. */
const SECRET_ARG = /(^|_)(token|password|secret|api_key|url)$/;

/** `AuthKey_<KEY ID>.p8` is the name fastlane's own documentation uses. */
const P8_KEY_ID = /(?:^|\/)AuthKey_([A-Z0-9]+)\.p8$/;

/**
 * Turns what a Fastfile literally says into what could be done about it.
 *
 * Pure, and deliberately so: every judgement about credentials is here, in one
 * function, beside the one table that describes them. `ruby/scan.rb` reports
 * what the file says and knows nothing of any of this.
 *
 * The order of the three passes is the order of confidence. A `json_key`
 * pointing at a literal path is unambiguous; an `api_token` holding a literal
 * might be a real token or might be a placeholder, so it falls through to the
 * unchecked tier rather than being claimed by a rule that was almost right.
 */
export function proposalsFor(literals: Literal[]): Proposal[] {
  const out: Proposal[] = [];

  for (const literal of literals) {
    if (literal.value.trim() === "") continue;

    const file = FILE_ARGS.find((r) => r.action.test(literal.action) && r.arg === literal.arg);
    if (file) {
      const name = defaultVarNames(file.kind)["path"]!;
      out.push({
        tier: "file",
        kind: file.kind,
        varName: name,
        literal,
        suggestedFields: suggestedFields(file.kind, literal.value),
        edit: { start: literal.valueStart, length: literal.valueLength, replacement: `ENV.fetch("${name}")` },
        checked: true,
      });
      continue;
    }

    const inline = INLINE_ARGS.find((r) => r.action.test(literal.action) && r.arg === literal.arg);
    if (inline) {
      const name = defaultVarNames(inline.kind)["path"]!;
      out.push({
        tier: "inline",
        kind: inline.kind,
        varName: name,
        literal,
        suggestedFields: {},
        // The whole pair, because the keyword changes too.
        edit: {
          start: literal.pairStart,
          length: literal.pairLength,
          replacement: `${inline.becomes}: ENV.fetch("${name}")`,
        },
        checked: true,
      });
      continue;
    }

    if (SECRET_ARG.test(literal.arg)) {
      const name = `${literal.action}_${literal.arg}`.toUpperCase();
      out.push({
        tier: "secret",
        varName: name,
        literal,
        suggestedFields: {},
        edit: { start: literal.valueStart, length: literal.valueLength, replacement: `ENV.fetch("${name}")` },
        // Unticked on purpose. This is the one tier where a false positive is
        // likely — a non-secret URL, a placeholder — and a patch applied by
        // default to a value that was not a secret is a silent regression in
        // someone's build.
        checked: false,
      });
    }
  }

  return out;
}

/** What the credential's filename gives away, so the prompt starts filled in. */
function suggestedFields(kind: CredentialKind, path: string): Record<string, string> {
  if (kind !== "apple_asc") return {};
  const keyId = P8_KEY_ID.exec(path)?.[1];
  return keyId ? { key_id: keyId } : {};
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/fastfile/adoption.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -p tsconfig.json --noEmit
git add src/fastfile/adoption.ts tests/fastfile/adoption.test.ts
git commit -m "Turn Fastfile literals into credential proposals"
```

---

## Task 7: the second act of setup

**Files:**
- Create: `src/cli/adopt.ts`
- Test: `tests/cli/adopt.test.ts`

The spec's mockup shows checkboxes. `Asker` (`src/cli/prompt.ts`) has `ask` and
`confirm` and nothing else, and it should stay that way — a setup command run
once should not grow a UI toolkit. So each proposal is one `confirm`, whose
default is the proposal's `checked`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAdoption } from "../../src/cli/adopt.js";
import { acceptingAsker } from "../../src/cli/prompt.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { tmpDir } from "../fixtures/repos.js";

/** A `confirm` that says no to everything, whatever the default. */
const refusingAsker = { ...acceptingAsker, async confirm() { return false; } };

async function project(fastfile: string, files: Record<string, string> = {}) {
  const dir = await tmpDir("laneyard-adopt-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  await writeFile(join(dir, "fastlane", "Fastfile"), fastfile, "utf8");
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, "utf8");
  }
  const home = await tmpDir("laneyard-home-");
  const db = openDatabase(join(home, "laneyard.db"));
  const vault = await Vault.open(home, new SecretStore(db), new CredentialStore(db));
  return { dir, home, db, vault };
}

const WITH_JSON = `lane :beta do\n  supply(json_key: "./play.json")\nend\n`;

describe("runAdoption", () => {
  it("stores the block and patches the Fastfile when accepted", async () => {
    const { dir, vault, db } = await project(WITH_JSON, { "play.json": `{"type":"service_account"}` });
    try {
      await runAdoption({ cwd: dir, fastlaneDir: "fastlane", slug: "app", vault, asker: acceptingAsker });

      expect(vault.listCredentials("app").map((c) => c.kind)).toEqual(["play_service_account"]);
      const after = await readFile(join(dir, "fastlane", "Fastfile"), "utf8");
      expect(after).toBe(`lane :beta do\n  supply(json_key: ENV.fetch("SUPPLY_JSON_KEY"))\nend\n`);
    } finally {
      db.close();
    }
  });

  it("writes nothing at all when declined", async () => {
    const { dir, vault, db } = await project(WITH_JSON, { "play.json": `{}` });
    try {
      await runAdoption({ cwd: dir, fastlaneDir: "fastlane", slug: "app", vault, asker: refusingAsker });

      expect(vault.listCredentials("app")).toEqual([]);
      expect(await readFile(join(dir, "fastlane", "Fastfile"), "utf8")).toBe(WITH_JSON);
    } finally {
      db.close();
    }
  });

  it("proposes nothing when the literal names a file that is not there", async () => {
    const { dir, vault, db } = await project(WITH_JSON);
    try {
      const res = await runAdoption({ cwd: dir, fastlaneDir: "fastlane", slug: "app", vault, asker: acceptingAsker });

      expect(res.applied).toBe(0);
      expect(vault.listCredentials("app")).toEqual([]);
      expect(await readFile(join(dir, "fastlane", "Fastfile"), "utf8")).toBe(WITH_JSON);
    } finally {
      db.close();
    }
  });

  it("leaves the Fastfile untouched when the vault write fails", async () => {
    const { dir, db } = await project(WITH_JSON, { "play.json": `{}` });
    const broken = {
      listCredentials: () => [],
      async setCredential() { throw new Error("vault is sealed"); },
    } as unknown as Vault;
    try {
      await expect(
        runAdoption({ cwd: dir, fastlaneDir: "fastlane", slug: "app", vault: broken, asker: acceptingAsker }),
      ).rejects.toThrow(/sealed/);
      expect(await readFile(join(dir, "fastlane", "Fastfile"), "utf8")).toBe(WITH_JSON);
    } finally {
      db.close();
    }
  });

  it("restores the Fastfile if the patch stops it parsing", async () => {
    // A pair range deliberately mis-stated would break the file; the re-parse
    // must catch it and put the original back.
    const { dir, vault, db } = await project(WITH_JSON, { "play.json": `{}` });
    try {
      await runAdoption({
        cwd: dir, fastlaneDir: "fastlane", slug: "app", vault, asker: acceptingAsker,
        editFor: () => ({ start: 0, length: 4, replacement: "lane :beta do do do" }),
      });
      expect(await readFile(join(dir, "fastlane", "Fastfile"), "utf8")).toBe(WITH_JSON);
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/adopt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fieldsOf } from "../credentials/kinds.js";
import { appRootOf } from "../heuristics/platforms.js";
import { proposalsFor } from "../fastfile/adoption.js";
import type { Proposal } from "../fastfile/adoption.js";
import { splice } from "../fastfile/splice.js";
import type { Edit } from "../fastfile/splice.js";
import { scanFastfile } from "../sidecar/scan.js";
import type { Vault } from "../secrets/vault.js";
import { bold, dim, heading, ok, warn } from "./style.js";
import type { Asker } from "./prompt.js";

const exec = promisify(execFile);

export interface AdoptionOptions {
  cwd: string;
  /** Relative to the repository root, as everything in setup is. */
  fastlaneDir: string;
  slug: string;
  vault: Vault;
  asker: Asker;
  /** Test seam: lets a test force an edit that breaks the file. */
  editFor?: (proposal: Proposal) => Edit;
}

export interface AdoptionResult {
  /** How many proposals were accepted and written. */
  applied: number;
}

/**
 * Setup's second act: what to do about credentials the Fastfile names outright.
 *
 * **It runs after the project is already set up, and that ordering is the
 * whole guarantee.** Declining everything here must leave exactly the project
 * setup produced before this feature existed — so the act is separate rather
 * than folded into setup's final confirmation, and "refusing works" is true by
 * construction instead of by promise.
 *
 * Nothing it can do is required. No Ruby with Prism, no Fastfile, an
 * unparseable file, a literal naming a file that is not on disk: every one of
 * those means "nothing proposed", and setup carries on.
 */
export async function runAdoption(options: AdoptionOptions): Promise<AdoptionResult> {
  const { cwd, fastlaneDir, slug, vault, asker } = options;

  const literals = await scanFastfile(cwd, fastlaneDir);
  if (literals === null) {
    process.stdout.write(
      "\n" + dim("Fastfile not analysed — no Ruby with Prism available. Nothing else changes.\n"),
    );
    return { applied: 0 };
  }

  // A literal pointing at nothing is dropped rather than reported: there is no
  // file to lift into the vault, and patching to a variable nothing supplies
  // would trade one broken build for another.
  // Resolved once, here, so the prompt, the vault write and the git check all
  // speak about the same file rather than each resolving the path again.
  const found = new Map<Proposal, { bytes: Buffer; path: string }>();
  const proposals: Proposal[] = [];
  for (const proposal of proposalsFor(literals)) {
    if (proposal.tier === "file") {
      const hit = await readCredential(cwd, fastlaneDir, proposal);
      if (hit === null) continue;
      found.set(proposal, hit);
    }
    proposals.push(proposal);
  }
  if (proposals.length === 0) return { applied: 0 };

  process.stdout.write(heading("I read your Fastfile"));

  const accepted: Proposal[] = [];
  for (const proposal of proposals) {
    process.stdout.write(describe(fastlaneDir, proposal) + "\n");
    if (await asker.confirm(`  Store it here and use ${bold(proposal.varName)}?`, proposal.checked)) {
      accepted.push(proposal);
    }
  }
  if (accepted.length === 0) {
    process.stdout.write(dim("\nNothing written. Your Fastfile is as it was.\n"));
    return { applied: 0 };
  }

  // The vault first, always. If lifting a credential fails, no Fastfile has
  // been patched to read a variable that nothing supplies.
  for (const proposal of accepted) await store(vault, slug, asker, proposal, found.get(proposal));

  const path = join(cwd, fastlaneDir, "Fastfile");
  const previous = await readFile(path, "utf8");
  const edits = accepted.map((p) => options.editFor?.(p) ?? p.edit);
  await writeFile(path, splice(previous, edits), "utf8");

  // Verified with Prism rather than with fastlane: setup has no server to ask
  // for a lane list, and "does it still parse" is the question that matters.
  // Same contract as `FastfileStore.write` — the previous content goes back on
  // disk before this function returns, and no backup file is left behind.
  if ((await scanFastfile(cwd, fastlaneDir)) === null) {
    await writeFile(path, previous, "utf8");
    process.stdout.write(
      "\n" + warn("The patch stopped the Fastfile parsing. It has been put back as it was.\n"),
    );
    return { applied: 0 };
  }

  await report(cwd, fastlaneDir, accepted, found);
  return { applied: accepted.length };
}

/**
 * The bytes behind a `file` proposal, or null when the path names nothing.
 *
 * **A relative path in a Fastfile has no single meaning.** `"./play.json"`
 * resolves against whatever directory fastlane was invoked from, which is
 * usually the app root — the fastlane folder's parent — but a project that runs
 * fastlane from the repository root, or writes paths relative to the fastlane
 * folder itself, is equally ordinary. Nothing in the file says which.
 *
 * So all three are tried, nearest first. This costs nothing to be wrong about:
 * the patch replaces the literal with `ENV.fetch` either way, and the only
 * thing the path is needed for is finding bytes to put in the vault. Failing to
 * find them means no proposal, which is the safe answer.
 */
async function readCredential(
  cwd: string,
  fastlaneDir: string,
  proposal: Proposal,
): Promise<{ bytes: Buffer; path: string } | null> {
  const value = proposal.literal.value;

  const candidates = isAbsolute(value)
    ? [value]
    : [
        resolve(cwd, appRootOf(fastlaneDir), value),
        resolve(cwd, fastlaneDir, value),
        resolve(cwd, value),
      ];

  for (const path of candidates) {
    const bytes = await readFile(path).catch(() => null);
    if (bytes !== null) return { bytes, path };
  }
  return null;
}

/** One proposal, as three lines: where, what, and why it will not survive. */
function describe(fastlaneDir: string, proposal: Proposal): string {
  const { literal } = proposal;
  const shown = proposal.tier === "inline" ? dim("(a key, inline in the file)") : `"${literal.value}"`;
  const why =
    proposal.tier === "inline"
      ? "This key is in your repository in cleartext."
      : proposal.tier === "file"
        ? "That path does not survive the clone: Laneyard builds from your remote."
        : "A literal secret in a build file is a secret in your history.";

  return (
    "\n" +
    `  ${bold(`${fastlaneDir}/Fastfile:${literal.line}`)}   ${literal.action}(${literal.arg}:)\n` +
    `                        → ${shown}\n` +
    dim(`  ${why}\n`)
  );
}

/** Lifts one accepted proposal into the vault. */
async function store(
  vault: Vault,
  slug: string,
  asker: Asker,
  proposal: Proposal,
  found: { bytes: Buffer; path: string } | undefined,
): Promise<void> {
  if (proposal.kind === undefined) {
    await vault.set(slug, proposal.varName, proposal.literal.value, true);
    return;
  }

  const bytes =
    proposal.tier === "inline" ? Buffer.from(proposal.literal.value, "utf8") : found!.bytes;
  // The original name is kept: some tools read meaning from it, and
  // `materialise.ts` already relies on `AuthKey_<KEY ID>.p8` surviving intact.
  const fileName =
    proposal.tier === "inline" ? `${proposal.kind}.key` : basename(found!.path);

  // The fields the file cannot carry. `fieldsOf` is the same table the web
  // upload form reads, so the CLI cannot end up asking for a different set.
  const fields: Record<string, string> = {};
  for (const field of fieldsOf(proposal.kind)) {
    if (field.optional) continue;
    const suggested = proposal.suggestedFields[field.name] ?? field.suggested ?? "";
    fields[field.name] = await asker.ask(`  ${field.label}`, suggested);
  }

  await vault.setCredential(slug, proposal.kind, { fileName, fileBytes: bytes, fields, varNames: {} });
}

/** What is left for the user to do, including the part Laneyard will not do. */
async function report(
  cwd: string,
  fastlaneDir: string,
  accepted: Proposal[],
  found: Map<Proposal, { bytes: Buffer; path: string }>,
): Promise<void> {
  process.stdout.write(
    "\n" +
      ok(`Stored ${accepted.length} credential${accepted.length > 1 ? "s" : ""} in this machine's vault.\n`) +
      ok(`Patched ${fastlaneDir}/Fastfile.\n`) +
      "\n" +
      // Said plainly because it is the trap `addProjectToConfig` already
      // documents: Laneyard builds from a clone of the remote, so nothing in
      // the working copy reaches a run until it is pushed.
      warn("Commit and push it, or your runs still read the old file.\n") +
      dim("  git diff -- " + join(fastlaneDir, "Fastfile") + "\n"),
  );

  // Said, never done. Removing a file from someone's repository is not
  // setup's to decide, and `git rm --cached` does not take it out of the
  // history anyway — so the honest thing is to name it.
  const tracked = await trackedCredentials(cwd, accepted, found);
  if (tracked.length > 0) {
    process.stdout.write(
      "\n" +
        warn(`${tracked.join(", ")} ${tracked.length > 1 ? "are" : "is"} tracked by git.\n`) +
        dim("  The patch does not take it out of your history. Rotating the key does.\n"),
    );
  }
}

/**
 * Which of the accepted credentials git already has. Silent when git cannot
 * answer — the same courtesy `fastlaneDirIsTracked` extends.
 *
 * Asked about the *resolved* paths, not the literals: `"./play.json"` written
 * in a Fastfile one directory down is not a path `git ls-files` can answer
 * about from the repository root.
 */
async function trackedCredentials(
  cwd: string,
  accepted: Proposal[],
  found: Map<Proposal, { bytes: Buffer; path: string }>,
): Promise<string[]> {
  const paths = accepted.flatMap((p) => {
    const hit = found.get(p);
    return hit ? [hit.path] : [];
  });
  if (paths.length === 0) return [];
  try {
    const { stdout } = await exec("git", ["ls-files", "--", ...paths], { cwd });
    return stdout.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/cli/adopt.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -p tsconfig.json --noEmit
git add src/cli/adopt.ts tests/cli/adopt.test.ts
git commit -m "Add setup's second act: lift credentials, offer the patch"
```

---

## Task 8: wire it into setup

**Files:**
- Modify: `src/cli/setup.ts:131-137` (`SetupOptions`), and after the success block at `:386`
- Modify: `src/main.ts:192`
- Test: `tests/cli/setup.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/setup.test.ts`, inside the existing
`describe("runSetupCommand")` block so the fixture helpers are in scope. Add
`import { acceptingAsker } from "../../src/cli/prompt.js";` at the top — the
file does not import it today.

`makeOriginRepo` is the wrong fixture here: it builds a repository with no
`origin` remote, and `detectProject` would return a null `gitUrl`, so setup
would refuse before reaching anything this task adds. Follow
`repoWithFastlaneAtRoot`'s shape instead.

```ts
/** The root-level shape, plus a credential the Fastfile names outright. */
async function repoWithHardcodedKey(): Promise<{ app: string; configPath: string; home: string }> {
  const root = await tmpDir("laneyard-adopt-setup-");
  await mkdir(join(root, "fastlane"), { recursive: true });
  await writeFile(
    join(root, "fastlane", "Fastfile"),
    `lane :beta do\n  supply(json_key: "./play.json")\nend\n`,
    "utf8",
  );
  await writeFile(join(root, "play.json"), `{"type":"service_account"}`, "utf8");
  await mkdir(join(root, "App.xcodeproj"), { recursive: true });
  await writeFile(join(root, "App.xcodeproj", "project.pbxproj"), "", "utf8");

  const run = promisify(execFile);
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["remote", "add", "origin", "git@example.com:you/keyed.git"], { cwd: root });

  return { app: root, configPath: join(await tmpDir(), "config.yml"), home: await tmpDir("laneyard-home-") };
}

it("registers the project even when every proposal is declined", async () => {
  // The guarantee the whole feature rests on: config.yml and laneyard.yml are
  // exactly what they were before adoption existed.
  const { app, configPath, home } = await repoWithHardcodedKey();
  const declining = {
    ...acceptingAsker,
    async confirm(question: string, defaultYes: boolean) {
      return question.includes("Store it here") ? false : defaultYes;
    },
  };

  const out = await captureStdout(async () => {
    expect(await runSetupCommand(app, configPath, { home, asker: declining })).toBe(0);
  });

  expect(out).toContain("is set up");
  expect((parse(await readFile(configPath, "utf8")) as { projects: unknown[] }).projects).toHaveLength(1);
  // And the Fastfile is byte-identical.
  expect(await readFile(join(app, "fastlane", "Fastfile"), "utf8")).toContain('"./play.json"');
});

it("reads the Fastfile only after the project is registered", async () => {
  const { app, configPath, home } = await repoWithHardcodedKey();

  const out = await captureStdout(async () => {
    await runSetupCommand(app, configPath, { home, asker: acceptingAsker });
  });

  expect(out).toContain("I read your Fastfile");
  expect(out.indexOf("is set up")).toBeLessThan(out.indexOf("I read your Fastfile"));
});

it("skips adoption entirely when no home is given", async () => {
  // Every existing caller and test passes no `home`; none of them may grow a
  // vault write or a Fastfile edit by accident.
  const { app, configPath } = await repoWithHardcodedKey();

  const out = await captureStdout(async () => {
    expect(await runSetupCommand(app, configPath, { yes: true })).toBe(0);
  });

  expect(out).not.toContain("I read your Fastfile");
  expect(await readFile(join(app, "fastlane", "Fastfile"), "utf8")).toContain('"./play.json"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/setup.test.ts -t "adoption"`
Expected: FAIL — `SetupOptions` has no `home`.

- [ ] **Step 3: Write the implementation**

In `src/cli/setup.ts`, add to `SetupOptions`:

```ts
  /**
   * Laneyard's home, for the vault the second act writes to.
   *
   * Optional so that every existing test — and any caller that only wants a
   * project registered — keeps working: without it, adoption is skipped
   * entirely rather than half-run.
   */
  home?: string;
```

Then, immediately before `return 0;` at the end of the `try` block (after the
whole success message has been written):

```ts
    // The second act. After the success message, never before it: declining
    // everything here must leave exactly the project the lines above just
    // announced. See `cli/adopt.ts`.
    if (options.home !== undefined) {
      const db = openDatabase(join(options.home, "laneyard.db"));
      try {
        const vault = await Vault.open(options.home, new SecretStore(db), new CredentialStore(db));
        await runAdoption({
          cwd: repoRoot(cwd, d.subPath),
          fastlaneDir,
          slug,
          vault,
          asker,
        });
      } catch (cause) {
        // Adoption is a courtesy on top of a command that has already
        // succeeded. Its failure is reported and swallowed: exiting non-zero
        // here would say the project was not set up, and the project is set up.
        process.stdout.write("\n" + warn(`Could not finish reading your Fastfile: ${(cause as Error).message}\n`));
      } finally {
        db.close();
      }
    }
```

with the imports it needs:

```ts
import { CredentialStore } from "../db/credentials.js";
import { openDatabase } from "../db/open.js";
import { SecretStore } from "../db/secrets.js";
import { Vault } from "../secrets/vault.js";
import { runAdoption } from "./adopt.js";
```

In `src/main.ts:192`, pass it through:

```ts
      process.exit(await runSetupCommand(process.cwd(), join(home, "config.yml"), { slug, yes, home }));
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. Watch particularly for existing `setup.test.ts` cases — they
pass no `home`, so adoption must not run for them at all.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/cli/setup.ts src/main.ts tests/cli/setup.test.ts
git commit -m "Run Fastfile adoption after setup has registered the project"
```

---

## Task 9: README and landing

**Files:**
- Modify: `README.md:28-31`
- Modify: the landing repository (`../laneyard-landing`)

The standing rule on this project is that the README and the landing are
checked together, and after every implemented feature.

- [ ] **Step 1: Replace the paragraph at README.md:28**

Current:

> The adaptation goes one way. A repository that builds today keeps building
> unedited: signing credentials reach your lanes under the variable names your
> Fastfile already reads, and where Laneyard needs to know something no file can
> tell it, it asks on a form rather than asking you to change the file.

New:

> The adaptation goes one way. Signing credentials reach your lanes under the
> variable names your Fastfile already reads, and where Laneyard needs to know
> something no file can tell it, it asks on a form. Where it finds a hardcoded
> path that will not survive a clone, it offers a fix and shows you the diff —
> an offer you can decline, and a repository that declines keeps building
> exactly as it did.

- [ ] **Step 2: Add a section under the setup documentation**

Describe the second act in the README's own voice: what it recognises, that the
three tiers exist, that the third is unticked, that setup never commits, and
that a patched Fastfile does nothing until it is pushed.

- [ ] **Step 3: Check the landing against the new README**

Run: `rg -n "unedited|adapts|one way" ../laneyard-landing`
Fix any sentence that now overstates "never touches your repository".

- [ ] **Step 4: Add a CHANGELOG entry**

Follow the existing format in `CHANGELOG.md`.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "Document Fastfile adoption in the README"
```

---

## Verification before calling this done

- [ ] `npm test` — the whole suite, not the files touched
- [ ] `npm run typecheck`
- [ ] Manual: run `laneyard setup` in a scratch repo whose Fastfile holds
      `supply(json_key: "./play.json")` with the file beside it. Confirm the
      order on screen (project set up, *then* the proposal), accept, and check
      that `git diff` shows exactly one changed line.
- [ ] Manual: the same, declining. `git status` must be clean and
      `laneyard secret list` empty.
- [ ] Manual: with `PATH` pointing at `/usr/bin/ruby` only
      (`env PATH=/usr/bin:/bin laneyard setup`), confirm setup completes and
      prints the "not analysed" line rather than failing.

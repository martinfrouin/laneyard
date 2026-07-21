# Laneyard — Milestone 4: the readiness checklist

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell someone exactly what stands between their project and a build that runs without them, and let them fix each thing from the same screen.

**Architecture:** A new sidecar command reports which actions each lane calls and with what literal arguments — the read-only half of what the Fastfile editor will need later. On top of it, a set of independent checks, each a detection and a remediation, living behind the heuristics boundary because they know fastlane by name.

**Tech Stack:** Prism, Ruby's own parser, already bundled. Existing stack otherwise.

**Reference:** `docs/superpowers/specs/2026-07-21-laneyard-design.md`, section "Non-interactive by default" and its checklist table.

---

## Why this screen exists

Laneyard's whole promise is a build that runs while nobody watches. Everything that breaks that
promise is the same class of problem: a credential that is not there, a `match` that wants to
write, a lane that will stop and ask a question. Each one fails the same way — a run that hangs or
dies at 2am with a message about something you configured weeks ago.

The checklist turns that into something you can read before it happens.

**The rule it must obey:** these checks know fastlane by name — `match`, `MATCH_PASSWORD`, App
Store Connect — so they live in `src/heuristics/`, and the boundary applies. They never block a
run, never hide a lane, never modify a Fastfile. They produce information, and the user decides.
A check being red must never be the reason something cannot be started.

---

## File structure

```
ruby/introspect.rb          (modified) new `uses` command
src/
  sidecar/
    uses.ts                 Reading and caching what each lane calls
  heuristics/
    blocking-actions.ts     Actions known to stop and ask
    readiness.ts            The five checks, each detection separate and independent
  server/routes/
    readiness.ts            GET the checklist for a project
web/src/pages/
    Readiness.tsx           The tab
```

---

### Task 1: The sidecar learns to read a lane

**Files:**
- Modify: `ruby/introspect.rb`
- Create: `tests/ruby/uses.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("introspect.rb uses", () => {
  it("reports the actions a lane calls, in order", async () => {
    const dir = await projectWithFastfile(`
      lane :beta do
        increment_build_number
        match(type: "appstore", readonly: true)
        build_app(scheme: "App")
      end
    `);
    const res = await introspect(dir, "uses") as {
      ok: boolean;
      lanes: { lane: string; actions: { name: string; args: Record<string, unknown> }[] }[];
    };

    expect(res.ok).toBe(true);
    const beta = res.lanes.find((l) => l.lane === "beta")!;
    expect(beta.actions.map((a) => a.name)).toEqual([
      "increment_build_number",
      "match",
      "build_app",
    ]);
  });

  it("reports literal keyword arguments, and only those", async () => {
    const dir = await projectWithFastfile(`
      lane :beta do
        match(type: "appstore", readonly: true, count: 3)
        build_app(scheme: ENV["SCHEME"])
      end
    `);
    const res = await introspect(dir, "uses") as any;
    const actions = res.lanes[0].actions;

    expect(actions[0].args).toEqual({ type: "appstore", readonly: true, count: 3 });
    // A value computed at runtime is not a literal: reporting a guess would be
    // worse than reporting nothing, because a checklist that lies is trusted.
    expect(actions[1].args).toEqual({});
  });

  it("sees through a platform block", async () => {
    const dir = await projectWithFastfile(`
      platform :ios do
        lane :beta do
          match(readonly: false)
        end
      end
    `);
    const res = await introspect(dir, "uses") as any;
    expect(res.lanes[0].lane).toBe("beta");
    expect(res.lanes[0].actions[0].args).toEqual({ readonly: false });
  });

  it("does not confuse a nested block for a lane's own calls", async () => {
    const dir = await projectWithFastfile(`
      lane :beta do
        if ENV["CLEAN"]
          clear_derived_data
        end
        build_app
      end
    `);
    const res = await introspect(dir, "uses") as any;
    // A conditional call is still a call the lane may make: it counts.
    expect(res.lanes[0].actions.map((a: any) => a.name)).toContain("clear_derived_data");
  });

  it("returns a structured error on an unparseable Fastfile", async () => {
    const dir = await projectWithFastfile("lane :beta do\n  # never closed\n");
    const res = await introspect(dir, "uses") as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

Add to `ruby/introspect.rb`, using Prism — Ruby's own parser, bundled since 3.3, and already the
tool this project chose for reading Fastfiles:

```ruby
require "prism"

# Literal values only, resolved by node type through a table.
#
# A Fastfile is arbitrary Ruby: `ENV["X"]` or a method call has no value until
# the lane runs, and a checklist that guesses is worse than one that stays quiet
# — it would be believed. Deciding from the node type rather than the converted
# value is also what keeps `false` and `nil` from being mistaken for absence.
LITERALS = {
  Prism::StringNode  => ->(n) { n.unescaped },
  Prism::SymbolNode  => ->(n) { n.unescaped },
  Prism::IntegerNode => ->(n) { n.value },
  Prism::FloatNode   => ->(n) { n.value },
  Prism::TrueNode    => ->(_) { true },
  Prism::FalseNode   => ->(_) { false },
  Prism::NilNode     => ->(_) { nil }
}.freeze

def literal_args(call)
  hash = (call.arguments&.arguments || []).find { |a| a.is_a?(Prism::KeywordHashNode) }
  return {} unless hash

  hash.elements.each_with_object({}) do |el, out|
    next unless el.is_a?(Prism::AssocNode) && el.key.is_a?(Prism::SymbolNode)
    reader = LITERALS[el.value.class]
    out[el.key.unescaped] = reader.call(el.value) if reader
  end
end

# Every call inside a lane's block, however deeply nested: a call inside an `if`
# is still a call the lane may make, and the checklist cares about what could
# happen, not only about what always happens.
def calls_within(node, out = [])
  node.compact_child_nodes.each do |child|
    if child.is_a?(Prism::CallNode) && child.receiver.nil?
      out << { name: child.name.to_s, args: literal_args(child) }
    end
    calls_within(child, out)
  end
  out
end

def collect_uses(fastfile_path)
  result = Prism.parse(File.read(fastfile_path))
  raise "Fastfile could not be parsed" unless result.success?

  lanes = []
  walk = lambda do |node|
    node.compact_child_nodes.each do |child|
      if child.is_a?(Prism::CallNode) && %w[lane private_lane].include?(child.name.to_s)
        name = child.arguments&.arguments&.first
        lanes << {
          lane: name.is_a?(Prism::SymbolNode) ? name.unescaped : "?",
          actions: child.block ? calls_within(child.block) : []
        }
      else
        # Not a lane: keep descending, so a `platform :ios do` block is seen through.
        walk.call(child)
      end
    end
  end
  walk.call(result.value)
  lanes
end
```

and a `when "uses"` branch mirroring the `lanes` one — the same `begin/rescue Exception` shape,
and `respond` outside the rescue for the reason already documented there.

> This walk is verified against real Ruby: `readonly: true` and `clean: false` are kept,
> `scheme: ENV["SCHEME"]` is omitted, a call inside an `if` is captured, and a `platform` block
> is seen through.

- [ ] **Step 4: Run the tests**

- [ ] **Step 5: Commit**

```bash
git add ruby/introspect.rb tests/ruby/uses.test.ts
git commit -m "feat(sidecar): report the actions each lane calls, with literal arguments"
```

---

### Task 2: Reading `uses` from TypeScript

**Files:**
- Create: `src/sidecar/uses.ts`, `tests/sidecar/uses.test.ts`

Mirror `src/sidecar/lanes.ts` exactly — same injected `Invoke`, same cache keyed on the hash of
the whole `fastlane_dir`, same rule that a failure is never cached. The only differences are the
command name and the shape returned.

- [ ] Steps 1–5 as usual, ending with:

```bash
git commit -m "feat(sidecar): cache what each lane calls"
```

---

### Task 3: Actions that stop and ask

**Files:**
- Create: `src/heuristics/blocking-actions.ts`, `tests/heuristics/blocking-actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover: an action known to prompt is reported; one that prompts *only* under a given argument is
reported only then (`match` with `readonly: false`); an unknown action is never reported; the
table is data, not code.

- [ ] **Step 2 to 4**

```ts
/**
 * Actions known to stop and wait for a human.
 *
 * Named knowledge of fastlane, hence its place in this module. It is a table
 * rather than code so that it stays legible as fastlane changes, and so that
 * adding an entry is not an invitation to add a branch.
 *
 * `when` is what makes an action blocking. Absent, it always is; present, only
 * when the lane calls it that way. `match(readonly: true)` is fine; the same
 * action allowed to create certificates will ask for an Apple account.
 */
export interface BlockingRule {
  action: string;
  when?: { arg: string; equals: unknown };
  because: string;
  fix: string;
}

export const BLOCKING_RULES: BlockingRule[] = [
  {
    action: "prompt",
    because: "asks a question and waits for an answer",
    fix: "Remove it from the lane, or give it a default that applies when `CI` is set.",
  },
  {
    action: "match",
    when: { arg: "readonly", equals: false },
    because: "may create certificates, which needs an Apple account interactively",
    fix: "Pass `readonly: true` so it only fetches what already exists.",
  },
  {
    action: "sync_code_signing",
    when: { arg: "readonly", equals: false },
    because: "may create certificates, which needs an Apple account interactively",
    fix: "Pass `readonly: true` so it only fetches what already exists.",
  },
  {
    action: "sigh",
    because: "renews provisioning profiles, which needs an Apple account interactively",
    fix: "Use `match` in readonly mode instead, with profiles stored in a repository.",
  },
];
```

plus a function that applies the table to a lane's actions. A rule whose `when` names an argument
the lane did not pass literally is **not** reported: the checklist would be guessing.

---

### Task 4: The checks

**Files:**
- Create: `src/heuristics/readiness.ts`, `tests/heuristics/readiness.test.ts`

Five independent checks. Each returns `{ id, title, state: "ok" | "warn" | "unknown", detail, fix? }`.
Nothing here throws; a check that cannot determine its answer returns `unknown` with a reason,
because a checklist that fails to load teaches the user to ignore it.

| id | Detection |
|---|---|
| `repository` | `git ls-remote --heads <url>` with `GIT_TERMINAL_PROMPT=0` and a short timeout |
| `dependencies` | `Gemfile` present → `bundle check` in the workspace; otherwise `fastlane` resolvable |
| `app-store-connect` | a secret named `APP_STORE_CONNECT_API_KEY_*` → ok; only `FASTLANE_SESSION` → warn, sessions expire; neither → warn |
| `match` | lanes call `match`/`sync_code_signing`? then `MATCH_PASSWORD` in the vault, and `readonly` not literally `false` |
| `blocking-actions` | the table from Task 3, applied to every lane |

Each check takes what it needs as arguments — no check reaches for a database or a config store
itself. That is what makes them testable without a server, and the tests should exercise every
branch of every check with plain values.

- [ ] Steps 1–5, ending with:

```bash
git commit -m "feat(heuristics): the five readiness checks"
```

---

### Task 5: Serving the checklist

**Files:**
- Create: `src/server/routes/readiness.ts`, `tests/server/readiness.test.ts`

`GET /api/projects/:slug/readiness` runs the checks and returns them.

Two things the route must get right:

- **It is never computed on its own.** The checks shell out to git and to bundler; doing that on
  every page load would make the interface feel broken. The route runs them when asked, and the
  interface asks when the user opens the tab or presses refresh.
- **It never fails as a whole.** One check throwing returns that check as `unknown`, not a 500.
  The spec is explicit that these are warnings; a checklist that disappears when one probe times
  out is worse than one that says "could not tell".

---

### Task 6: The tab

**Files:**
- Create: `web/src/pages/Readiness.tsx`
- Modify: `web/src/pages/Project.tsx`, `web/src/api.ts`, `web/src/status.ts`

Same grammar as everywhere else: one status line per check — marker, title, dim detail. `✓` for
ok, `▸` amber for a warning, `○` dim for unknown. The fix goes on a second line under the check
that needs it, in the dim colour, as a sentence rather than a button — most of these are fixed by
editing a Fastfile or adding a secret, and pretending otherwise with a one-click button that
opens a form would be a lie about how much Laneyard can do for you.

Where a fix *is* one action — adding `MATCH_PASSWORD`, storing an App Store Connect key — link to
the Secrets tab rather than duplicating its form.

The tab shows the time of the last check and a `refresh` control, because a stale green tick is
the one thing worse than a red cross.

---

### Task 7: Say so

- README: the roadmap line `○ a checklist that gets a project running unattended` becomes `✓`;
  a short section describing what the checklist covers **and what it cannot see** — it reads
  literal arguments only, so a `match` whose `readonly` comes from a variable is reported as
  unknown rather than green.
- The landing page roadmap, in the other repository.
- `CHANGELOG.md` gains the entry.

---

## What this milestone does not do

- **Fixing anything by itself.** Every check explains; the user acts. That is the heuristics
  boundary, and it is deliberate: a tool that edits your Fastfile to make its own checklist go
  green is a tool you cannot trust with a Fastfile.
- **Understanding a Fastfile that computes.** Arguments are read as literals. `match(readonly: ENV["RO"])`
  is honestly reported as undetermined, never guessed.
- **Checking Android signing.** The keystore checks have no equivalent to `match` to reason about;
  worth its own pass once someone is running Android builds unattended.

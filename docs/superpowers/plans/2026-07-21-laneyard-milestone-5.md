# Laneyard — Milestone 5: editing the Fastfile

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change a lane from the browser, run it to see whether it worked, then commit and push — without opening an editor or an SSH session.

**Architecture:** The Fastfile is read from and written to the project's git workspace. Every write is verified by asking fastlane whether the file still parses and still has the same lanes; if it does not, the previous content is put back. A separate panel shows the diff and commits it.

**Tech Stack:** CodeMirror 6 with the legacy Ruby stream mode — bundled, never fetched, since this tool runs on machines with no internet. Existing stack otherwise.

**Reference:** `docs/superpowers/specs/2026-07-21-laneyard-design.md`, section "The hybrid editor".

---

## Why only half the editor

The design describes two modes: a structured view where a known action with literal arguments
becomes a form, and a text mode for everything else. This milestone ships **only the text mode**,
and that is the order the milestone-1 plan already argued for: the text editor alone is useful,
the structured view alone is not. Someone who can edit a Fastfile from the browser, run it, and
push it has the whole loop; someone who can only edit `build_app`'s parameters has a toy.

The structured view also depends on two things that do not exist yet — the full action catalogue
from the sidecar, and surgical rewriting by byte range — and both are large enough to deserve
their own milestone rather than being rushed in behind an editor that already works.

---

## The rule this milestone lives under

**A file written by hand must never come back mangled.** It is the same promise the configuration
already keeps, and here it is stronger, because a Fastfile is code someone else may have spent a
long time on.

Concretely: Laneyard writes exactly the bytes it was given, verifies the result, and puts the old
content back if the verification fails. It never reformats, never reorders, never "tidies".

---

## File structure

```
src/
  fastfile/
    store.ts       Read, write with backup, verify, restore on failure
  git/
    workspace.ts   (modified) status, diff, commit, push
  server/routes/
    fastfile.ts    Read, write, and the git panel's actions
web/src/pages/
    Fastfile.tsx   The editor and the changes panel
```

---

### Task 1: Reading and writing, safely

**Files:**
- Create: `src/fastfile/store.ts`, `tests/fastfile/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("FastfileStore", () => {
  it("reads the file as it is on disk", async () => { … });

  it("writes exactly the bytes it was given", async () => {
    // No reformatting, no trailing-newline fixing, no reordering. Someone's
    // comments and indentation are theirs.
    const weird = "lane :beta do\r\n\t# odd but theirs\r\n  end\r\n\r\n";
    await store.write(dir, weird, verifyAlways);
    expect(await store.read(dir)).toBe(weird);
  });

  it("puts the previous content back when verification fails", async () => {
    const before = await store.read(dir);
    const result = await store.write(dir, "lane :beta do  # never closed", verifyNever);

    expect(result.ok).toBe(false);
    expect(await store.read(dir)).toBe(before);
  });

  it("reports why verification failed, in the verifier's own words", async () => { … });

  it("refuses to write outside the fastlane directory", async () => {
    // The path comes from configuration, but a fastlane_dir of `../../etc` must
    // not turn an editor into a way to write anywhere on the machine.
    await expect(store.read(dir, "../../../etc/hosts")).rejects.toThrow(/outside/i);
  });

  it("leaves no backup file behind on success", async () => {
    // A stray `Fastfile.bak` in a git workspace shows up as an untracked file
    // and eventually gets committed by someone in a hurry.
  });
});
```

- [ ] **Step 2 to 4: implement, run, verify**

`write(workspacePath, content, verify)`:
1. Read the current content and keep it in memory — not in a sibling file, which would litter the
   git workspace.
2. Write the new content.
3. `await verify()`. The verifier is injected: the store knows nothing about fastlane, and the
   tests need no Ruby.
4. On failure, write the old content back and return the verifier's reason.

The verifier used in production asks the sidecar for the lanes: it parses the file and lists what
it found, which is exactly the two things that matter — it still parses, and the lanes are still
there. Cheaper than inventing a second check, and it fails the same way a run would.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(fastfile): write with verification, and restore on failure"
```

---

### Task 2: What git has to say

**Files:**
- Modify: `src/git/workspace.ts`, `tests/git/workspace.test.ts`

Four additions, each a thin wrapper over a git command, each with a test against a real
repository — the suite already does this and it is why the git layer has held up:

- `status()` → the paths that changed, tracked only.
- `diff(path?)` → the unified diff, as text.
- `commit(message, paths)` → stages exactly those paths and commits. **Never `git add -A`**: a
  build leaves files in the workspace, and committing them because they happened to be there is
  the kind of thing that ends up in someone's release.
- `push(branch)` → pushes, and returns git's own message on failure rather than a generic one.

Note the commit needs an author. Take it from the repository's own git configuration if it has
one; otherwise commit as `Laneyard <laneyard@localhost>` and say so in the interface, because a
commit from a name nobody recognises is worse than one that admits what made it.

---

### Task 3: The routes

**Files:**
- Create: `src/server/routes/fastfile.ts`, `tests/server/fastfile.test.ts`

```
GET    /api/projects/:slug/fastfile          → { content, dirty, diff }
PUT    /api/projects/:slug/fastfile          → 204, or 400 with the verification failure
GET    /api/projects/:slug/changes           → { files, diff }
POST   /api/projects/:slug/commit            → { message } → 204
POST   /api/projects/:slug/push              → 204, or 400 with git's message
```

Three things the routes must get right:

- **The workspace must exist.** `ensureWorkspace` first, as the lanes route does.
- **A write invalidates the introspection cache**, or the lane list stays stale until the next
  run. The cache is keyed on a hash of the whole `fastlane_dir`, so this happens on its own — but
  there is a test to write proving it, because "it happens on its own" is how caches go wrong.
- **Refuse to write while that project has a run in flight.** The run is reading the file it is
  building from. This is the one place in the milestone where something is refused, and it is not
  a heuristic: it is the same reason preparation refuses to move a dirty workspace.

---

### Task 4: The editor

**Files:**
- Create: `web/src/pages/Fastfile.tsx`
- Modify: `web/src/pages/Project.tsx`, `web/src/api.ts`, `web/src/App.tsx`
- Modify: `package.json` — `codemirror`, `@codemirror/legacy-modes`, `@codemirror/lang-*` as needed

- [ ] **Step 1: The editor itself**

CodeMirror 6 with `StreamLanguage.define(ruby)` from `@codemirror/legacy-modes/mode/ruby`, a dark
theme matching the terminal pane, and no line wrapping — a Fastfile is code.

**Bundled, never fetched.** This tool runs on machines that may have no internet; a CDN import
would be an outage waiting to happen.

- [ ] **Step 2: Saving**

`save` is explicit, never automatic. An editor that saves as you type would run verification on
every keystroke and, worse, would write a broken file to a workspace a run might pick up.

When verification fails, the message is shown **above the editor with the content still in the
box** — the user's work is not lost, and the file on disk is already back to what it was.

- [ ] **Step 3: The changes panel**

Below the editor: the diff, a message field, `commit`, and `push` once there is something to push.
Plain text diff in the terminal palette, `+` green and `-` red — the two colours already mean
success and failure here, and a diff is the one place that reading is universal.

- [ ] **Step 4: See it work**

Edit a lane, save it, run it, commit it, push it to a local bare repository, and check the commit
landed with the expected message and only the expected file.

---

### Task 5: Say so

- README: the roadmap line for the editor becomes `✓`, with a section saying plainly that this is
  the text editor — the structured view is still to come — and that every write is verified.
- The landing page roadmap, in the other repository.
- `CHANGELOG.md`, under 0.2.0.

---

## What this milestone does not do

- **The structured view.** Named, planned, and deliberately not rushed in behind an editor that
  already works. It needs the sidecar's full action catalogue and rewriting by byte range.
- **Editing anything but the Fastfile.** An `Appfile` or a `Pluginfile` changes what a build does
  just as much; the same store handles them once the interface has somewhere to put them.
- **Resolving conflicts.** If the remote has moved on, `push` fails and reports what git said. A
  pull-and-merge flow in a browser is a project of its own, and doing it badly loses work.

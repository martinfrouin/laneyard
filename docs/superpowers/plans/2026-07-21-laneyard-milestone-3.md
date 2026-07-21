# Laneyard — Milestone 3: the build queue and cancellation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trigger as many builds as you like; they wait their turn and run one at a time, and you can cancel one whether it has started or not.

**Architecture:** A FIFO queue that lives in the database, not in memory: a run's `queued` status *is* its place in line, so a restart resumes the queue instead of losing it. One worker drains it. Cancellation is an `AbortSignal` threaded into the runner, which kills the pseudo-terminal the same way the timeout already does.

**Tech Stack:** No new dependency. Existing stack: TypeScript, better-sqlite3, Fastify, React.

**Reference:** `docs/superpowers/specs/2026-07-21-laneyard-design.md`, section "Run lifecycle".

---

## What this replaces

Milestone 1 refused a second run on a project with a 409, because two runs would share one git
workspace and quietly corrupt each other's results. That refusal was a stopgap, and it is the
wrong answer to "I want to build twice": the second build should wait, not be turned away.

**One run at a time, globally.** Not one per project — one, full stop. A mobile build saturates
the machine it runs on, and two at once are frequently slower than two in sequence. Running
several in parallel would also need a working directory per run, which is a different piece of
work; the design note at the end says what it would take.

`max_concurrent_runs` already exists in the configuration and is unused. Rather than let it accept
a number nothing honours, it is **refused at load time above 1** — the same stance taken with
`git_auth: { kind: token }` in the previous milestone. A setting that silently does nothing is a
trap for whoever finds it.

---

## File structure

```
src/
  runner/
    queue.ts       The FIFO worker: takes the next run, runs it, takes the next
  db/
    runs.ts        (modified) queue-order reads, restart handling
  server/
    routes/runs.ts (modified) enqueue instead of refuse, and a cancel route
web/src/
  pages/Run.tsx    (modified) position in line, and a cancel button
```

---

### Task 1: Queue-aware run reads

The queue needs two things the store does not offer yet: the runs waiting, in order, and a
restart that keeps them.

**Files:**
- Modify: `src/db/runs.ts`, `tests/db/runs.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
  it("lists queued runs oldest first, whatever the project", () => {
    const s = store();
    const a = s.create({ projectSlug: "one", lane: "beta", platform: null, params: {} });
    const b = s.create({ projectSlug: "two", lane: "beta", platform: null, params: {} });
    const c = s.create({ projectSlug: "one", lane: "release", platform: null, params: {} });
    s.markRunning(b, { branch: "main", commitSha: "x" });

    // b has started, so it is no longer waiting; a queued before c.
    expect(s.queued().map((r) => r.id)).toEqual([a, c]);
  });

  it("reports where a run sits in the queue", () => {
    const s = store();
    const a = s.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });
    const b = s.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    expect(s.queuePosition(a)).toBe(1);
    expect(s.queuePosition(b)).toBe(2);
    s.setStatus(a, "running");
    expect(s.queuePosition(b)).toBe(1);
    expect(s.queuePosition(a)).toBeNull();
  });

  it("keeps queued runs across a restart and interrupts only what was in flight", () => {
    const s = store();
    const waiting = s.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });
    const started = s.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });
    s.markRunning(started, { branch: "main", commitSha: "x" });

    // A queued run never began: losing it on restart would be a silent surprise.
    expect(s.interruptInFlight()).toBe(1);
    expect(s.get(started)?.status).toBe("interrupted");
    expect(s.get(waiting)?.status).toBe("queued");
  });

  it("counts what is running, so the worker knows whether the machine is busy", () => {
    const s = store();
    expect(s.activeCount()).toBe(0);
    const id = s.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });
    s.markRunning(id, { branch: "main", commitSha: "x" });
    expect(s.activeCount()).toBe(1);
    s.finish(id, { status: "success", exitCode: 0, errorSummary: null });
    expect(s.activeCount()).toBe(0);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- tests/db/runs.test.ts`

- [ ] **Step 3: Implement**

In `src/db/runs.ts`, replace `interruptActive()` with `interruptInFlight()` — the old name
described what it did, the new one describes what it must *not* do — and add the queue reads:

```ts
/** Statuses that mean a run has begun and cannot survive the process that started it. */
const IN_FLIGHT: RunStatus[] = ["preparing", "running"];
```

```ts
  /** Runs waiting to start, oldest first. Insertion order is the queue. */
  queued(): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM run WHERE status = 'queued' ORDER BY id")
      .all() as RunRow[];
    return rows.map(toRun);
  }

  /** 1 for the next to start, null if the run is not waiting. */
  queuePosition(id: number): number | null {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS ahead FROM run
         WHERE status = 'queued' AND id <= ?
           AND EXISTS (SELECT 1 FROM run r2 WHERE r2.id = ? AND r2.status = 'queued')`,
      )
      .get(id, id) as { ahead: number };
    return row.ahead === 0 ? null : row.ahead;
  }

  /** How many runs have begun. The worker consults it before taking the next. */
  activeCount(): number {
    const placeholders = IN_FLIGHT.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM run WHERE status IN (${placeholders})`)
      .get(...IN_FLIGHT) as { n: number };
    return row.n;
  }

  /**
   * Marks as interrupted every run that had begun, leaving queued ones alone.
   *
   * A run that started cannot survive the process that spawned it — its
   * pseudo-terminal died with it. A queued run never began: it still means
   * exactly what it meant, and dropping it would be a silent surprise for
   * someone who queued three builds and restarted the server.
   */
  interruptInFlight(): number {
    const placeholders = IN_FLIGHT.map(() => "?").join(", ");
    const res = this.db
      .prepare(`UPDATE run SET status = 'interrupted', finished_at = ? WHERE status IN (${placeholders})`)
      .run(now(), ...IN_FLIGHT);
    return res.changes;
  }
```

Update the caller in `src/main.ts` and the two references in `tests/db/runs.test.ts`. Delete the
now-unused `ACTIVE` constant while you are there — a list of statuses nothing reads is the kind of
thing that gets updated wrongly six months later.

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/db/ tests/main.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/db/runs.ts src/main.ts tests/db/runs.test.ts tests/main.test.ts
git commit -m "feat(db): queue-order reads, and keep queued runs across a restart"
```

---

### Task 2: Cancellation in the runner

**Files:**
- Modify: `src/runner/orchestrate.ts`, `src/runner/pty.ts`, `tests/runner/orchestrate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("stops a running build and records it as cancelled", async () => {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n", ".gitignore": "build/\n" });
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    const controller = new AbortController();
    // The `slow` scenario sleeps; abort once output proves it really started.
    const done = executeRun({
      runId, runs, logs,
      workspacePath: join(root, "workspaces", "p"),
      artifactsDir: join(root, "artifacts", String(runId)),
      gitUrl: origin,
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "slow" },
      signal: controller.signal,
      onChunk: (chunk) => {
        if (chunk.includes("Compiling")) controller.abort();
      },
    });

    const result = await done;
    expect(result.status).toBe("cancelled");
    expect(runs.get(runId)?.status).toBe("cancelled");
    // Cancelling is not failing: the summary must not read like a crash.
    expect(runs.get(runId)?.errorSummary).toMatch(/cancel/i);
  }, 60_000);

  it("cancels before fastlane starts without leaving the run behind", async () => {
    // Aborting during preparation must still produce a finished run, not a ghost.
    const controller = new AbortController();
    controller.abort();
    // …executeRun with that signal…
    expect(runs.get(runId)?.status).toBe("cancelled");
  }, 60_000);
```

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

`ExecuteRunResult` gains `"cancelled"`. `ExecuteRunOptions` gains:

```ts
  /** Aborting stops the run: the pseudo-terminal is signalled, as on timeout. */
  signal?: AbortSignal;
```

**`src/runner/pty.ts` first.** `executeRun` currently writes `const { done } = startPty({…})` and
throws the handle away, and `PtyHandle.kill` sends a single signal. The SIGINT-then-SIGKILL
escalation exists only inside the timeout branch — so a fastlane that ignores SIGINT would block
the one global worker until `timeout_minutes` elapsed, with every queued run stuck behind it.

Give `startPty` the signal and let cancellation and timeout share one kill path:

```ts
export interface PtyRunOptions {
  // …existing fields…
  /** Aborting stops the process, with the same escalation as the timeout. */
  signal?: AbortSignal;
}
```

Extract what the timeout already does into a named function, and point both at it:

```ts
  /**
   * SIGINT first so fastlane can clean up after itself; SIGKILL five seconds
   * later if it will not. One path, so cancelling and timing out cannot drift
   * apart — and so neither can leave the single worker blocked.
   */
  const stop = () => {
    try {
      proc.kill("SIGINT");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5000);
  };

  opts.signal?.addEventListener("abort", stop, { once: true });
```

Remove that listener when the process exits, so a signal that outlives the run does not accumulate
listeners. Then in `executeRun`, simply pass `signal: opts.signal` through to `startPty` — no
handle needs to escape.

Check the signal at the two points before fastlane starts — before preparing the workspace and
after resolving settings — and finish the run as `cancelled` there rather than starting work that
is already unwanted. Those exits must flush and close the log writer exactly as `fail()` does;
extract a small `finishAs(status, summary)` helper so the three exits cannot drift apart.

The final verdict gains a case, ahead of the failure one:

```ts
  if (opts.signal?.aborted) {
    runs.finish(runId, {
      status: "cancelled",
      exitCode: outcome.exitCode,
      errorSummary: "Cancelled",
    });
    return { status: "cancelled" };
  }
```

- [ ] **Step 4: Run the tests**

- [ ] **Step 5: Commit**

```bash
git add src/runner tests/runner/orchestrate.test.ts
git commit -m "feat(runner): cancel a run through an abort signal"
```

---

### Task 3: The queue worker

**Files:**
- Create: `src/runner/queue.ts`, `tests/runner/queue.test.ts`

- [ ] **Step 1: Write the failing tests**

The worker is testable without fastlane by injecting the function it calls for each run:

```ts
  it("runs queued jobs one at a time, in order", async () => {
    const order: number[] = [];
    let inFlight = 0;
    let peak = 0;

    const queue = new RunQueue(runs, async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(id);
      await new Promise((r) => setTimeout(r, 20));
      runs.finish(id, { status: "success", exitCode: 0, errorSummary: null });
      inFlight -= 1;
    });

    const a = enqueue(); const b = enqueue(); const c = enqueue();
    queue.wake();
    await queue.idle();

    expect(order).toEqual([a, b, c]);
    expect(peak).toBe(1); // the whole point
  });

  it("picks up runs that were already queued when it started", …);
  it("keeps going after a job throws", …);           // one bad run must not stall the queue
  it("cancels a queued run without ever running it", …);
  it("cancels the run in flight through its signal", …);
  it("stops accepting work once closed", …);
```

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

`src/runner/queue.ts`:

```ts
import type { RunStatus, RunStore } from "../db/runs.js";

/** Statuses from which a run never moves again. */
const TERMINAL: RunStatus[] = ["success", "failed", "cancelled", "interrupted"];

export type RunJob = (runId: number, signal: AbortSignal) => Promise<void>;

/**
 * Drains queued runs, one at a time.
 *
 * The queue is not held in memory: a run's `queued` status in the database *is*
 * its place in line. That is what lets the server restart mid-queue and carry
 * on, and what makes the position shown in the interface the truth rather than
 * a second copy of it.
 *
 * One at a time, globally. A mobile build saturates the machine it runs on, and
 * two at once are frequently slower than two in sequence.
 */
export class RunQueue {
  private draining = false;
  private pending = false;
  private closed = false;
  private idlePromise: Promise<void> = Promise.resolve();
  private readonly running = new Map<number, AbortController>();

  constructor(
    private readonly runs: RunStore,
    private readonly job: RunJob,
  ) {}

  /** Tells the queue there may be work. Safe to call at any time, from anywhere. */
  wake(): void {
    if (this.closed) return;
    if (this.draining) {
      // A call arriving mid-drain is remembered rather than dropped: the drain
      // may already have read an empty queue and be on its way out.
      this.pending = true;
      return;
    }
    this.draining = true;
    this.idlePromise = this.drainUntilQuiet().finally(() => {
      this.draining = false;
    });
  }

  private async drainUntilQuiet(): Promise<void> {
    do {
      this.pending = false;
      await this.drain();
    } while (this.pending && !this.closed);
  }

  /** Resolves when the queue has nothing left to do. For tests and shutdown. */
  async idle(): Promise<void> {
    await this.idlePromise;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.closed) return;
      // One at a time: if something is already in flight — including a run this
      // process did not start — the queue waits rather than doubling up.
      if (this.runs.activeCount() > 0) return;

      const next = this.runs.queued()[0];
      if (!next) return;

      const controller = new AbortController();
      this.running.set(next.id, controller);
      try {
        await this.job(next.id, controller.signal);
      } catch {
        // A job that throws must not stall every run behind it. `executeRun`
        // promises not to, but the queue cannot afford to depend on that.
      } finally {
        this.running.delete(next.id);

        // Whatever happened, the run must not still be waiting or in flight.
        //
        // Two failures hide here, and both are worse than a wrong status. If the
        // job returns without moving the run out of `queued` — a project deleted
        // from config.yml while its run waited, say — the next iteration reads
        // the same row and calls the job again, forever. And a job that throws
        // after `executeRun` reached `preparing` leaves a run with no end, which
        // the interface polls until someone gives up.
        const after = this.runs.get(next.id);
        if (after && !TERMINAL.includes(after.status)) {
          this.runs.finish(next.id, {
            status: "failed",
            exitCode: null,
            errorSummary: "The run ended unexpectedly",
          });
        }
      }
    }
  }

  /**
   * Cancels a run whether it has started or not.
   *
   * A run still waiting is finished on the spot: there is nothing to signal, and
   * making someone wait for a build they have cancelled would be absurd.
   */
  cancel(runId: number): boolean {
    const active = this.running.get(runId);
    if (active) {
      active.abort();
      return true;
    }

    const run = this.runs.get(runId);
    if (run?.status !== "queued") return false;

    this.runs.finish(runId, { status: "cancelled", exitCode: null, errorSummary: "Cancelled before it started" });
    return true;
  }

  /** Stops taking new work; the run in flight is left to finish. */
  close(): void {
    this.closed = true;
  }
}
```

- [ ] **Step 4: Run the tests**

- [ ] **Step 5: Commit**

```bash
git add src/runner/queue.ts tests/runner/queue.test.ts
git commit -m "feat(runner): a queue that drains one run at a time"
```

---

### Task 4: Enqueue instead of refuse

**Files:**
- Modify: `src/server/app.ts`, `src/server/routes/runs.ts`, `src/main.ts`
- Modify: `tests/server/api.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the 409 test — the behaviour it pins is exactly what this milestone removes:

Note what the cancel test may and may not assert. Cancelling a **queued** run is synchronous:
there is nothing to signal, so the status is `cancelled` by the time the response returns.
Cancelling a **running** one only aborts a signal; SIGINT, the process exiting and `runs.finish`
are several async hops away, so a test that reads the status straight after the 204 will still see
`running`. Assert the synchronous case here, and leave the running case to Task 2's runner test,
which already waits for the run to end.

```ts
  it("queues a second run instead of refusing it", async () => {
    // …two POSTs…
    expect(second.statusCode).toBe(201);
    expect((second.json() as { queuePosition: number }).queuePosition).toBeGreaterThan(0);
  });

  it("reports a run's place in line", …);   // GET /api/runs/:id includes queuePosition
  it("cancels a queued run on the spot", …);   // 204, and status is `cancelled` immediately
  it("404s cancelling a run that does not exist", …);
  it("409s cancelling a run that already finished", …);
```

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

Remove the active-run check in `POST /api/projects/:slug/runs`. After creating the run, call
`ctx.queue.wake()` and answer `201 { id, queuePosition }`.

**Build the queue inside `buildApp`, immediately after `ctx`** — not in `createServerFromConfig`.
The job needs `runs`, `logs`, `workspacePath`, `artifactsDir`, `sockets` and `broadcastRunChunk`,
none of which exist before `ctx` does; and `tests/server/api.test.ts` calls `buildApp` directly,
so a queue arriving through `AppDeps` would have to be hand-built in every server test. The
configuration and the vault are already in `AppDeps` and reachable there.

Move the whole `executeRun` call — including the `.then(sockets.finish)` and the last-resort
`.catch` — out of the route and into the job. The route creates a row and rings the bell; nothing
else.

```ts
  ctx.queue = new RunQueue(ctx.runs, async (runId, signal) => {
    const run = ctx.runs.get(runId);
    if (!run) return;
    const slug = run.projectSlug;
    const entry = deps.config.project(slug);
    if (!entry) {
      // The project was removed from config.yml while this run waited. Ending it
      // here is what keeps the queue from re-reading the same row for ever.
      ctx.runs.finish(runId, {
        status: "failed",
        exitCode: null,
        errorSummary: `Project "${slug}" is no longer in the configuration`,
      });
      return;
    }
    // …executeRun with entry, signal, secrets, maskedValues…
  });
```

Add `POST /api/runs/:id/cancel`, and include `queuePosition` in `GET /api/runs/:id`.

`AppContext` gains `queue: RunQueue`.

**Wake the queue at boot, in `src/main.ts`.** Without this, the restart-resume that the whole
architecture rests on never happens: `wake()` would only ever be called from the trigger route, so
three runs queued before a restart would sit there until someone happened to trigger a fourth.

```ts
  // Anything left queued from the previous life starts moving again now.
  app.queue.wake();
```

Add a test for it at the `createServerFromConfig` level, not only the unit level — the unit test
in Task 3 calls `wake()` itself, so it cannot catch a missing call at startup:

```ts
  it("resumes a run left queued by a previous life", async () => {
    // …write config.yml, create a run directly in the database with status
    // `queued`, then call createServerFromConfig and assert the run leaves
    // `queued` on its own.
  });
```

- [ ] **Step 4: Run the whole suite**

- [ ] **Step 5: Commit**

```bash
git add src/server src/main.ts tests/server/api.test.ts tests/main.test.ts
git commit -m "feat(server): queue a run instead of refusing it, and allow cancelling"
```

---

### Task 5: Refuse a concurrency the queue does not honour

**Files:**
- Modify: `src/config/schema.ts`, `tests/config/load.test.ts`, `README.md`

- [ ] **Step 1: Write the failing test**

```ts
  it("refuses a concurrency the queue cannot honour", async () => {
    // Accepting 4 would promise parallel builds that never happen. Parallel runs
    // need a working directory per run; until then, saying no is the honest answer.
    const res = await loadServerConfig(await withConfig(`
server: { password_hash: "x", max_concurrent_runs: 4 }
projects: []
`));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/max_concurrent_runs/);
  });
```

- [ ] **Step 2 to 4: implement, run, verify**

`z.literal(1).default(1)` with a `.describe()` is not enough — the message matters more than the
constraint. Use a refinement that explains why, in the same voice as the `git_auth` refusal, and
give it `path: ["max_concurrent_runs"]`: `src/config/load.ts` formats an error as
`path.join(".") + " : " + message`, so a refinement without a path reports `(root)` and the test's
assertion on the field name would pass or fail for the wrong reason.

- [ ] **Step 5: Commit**

---

### Task 6: Show the queue

**Files:**
- Modify: `web/src/pages/Run.tsx`, `web/src/pages/Project.tsx`, `web/src/api.ts`, `web/src/theme.css`

- [ ] **Step 1: The run screen**

A queued run says where it is in line — `waiting · 2nd in queue` — rather than sitting on an empty
terminal with no explanation. The terminal pane says `waiting for its turn` instead of `waiting
for output`, because the two mean different things to someone watching.

- [ ] **Step 2: Cancelling**

A `cancel` button on any run that has not finished. It asks for no confirmation — cancelling a
build is cheap and reversible by triggering another, and a confirmation dialogue on a cheap action
trains people to click through dialogues.

After cancelling, the run keeps its log: what it managed to do before being stopped is often the
reason it was stopped.

- [ ] **Step 3: The project screen**

Queued runs appear in the run list with their position, so a queue of three is visible without
opening anything.

- [ ] **Step 4: See it work**

Queue three runs, watch them execute in order, cancel the one in the middle while it waits and the
one running, and confirm the queue carries on.

- [ ] **Step 5: Commit**

---

### Task 7: Say so

**Files:**
- Modify: `README.md`, and `index.html` in `/Users/martin/Projets/laneyard-landing`

- [ ] **Step 1: Move the roadmap line**

`▸ build queue, cancellation, timeouts` becomes `✓`, in both places. They are separate
repositories and nothing enforces that they agree.

- [ ] **Step 2: Retire the known limitation**

The README says today: *"a second run on a project is refused while the first is still going,
since they would share one git workspace."* That is no longer true. What is true, and should
replace it: runs execute one at a time across all projects, and a queued run survives a restart.

- [ ] **Step 3: The comparison table**

`build queue across a team` currently reads `planned` for Laneyard. It becomes `yes` — with the
honest caveat kept nearby that the queue is serial, not parallel.

- [ ] **Step 4: Commit both repositories**

---

## What this milestone does not do

- **Parallel builds.** Deliberate, and the reason is not laziness: two runs of the same project
  would share one git workspace, and the second would change the commit under the first, carry off
  its artifacts and delete its report. Doing it properly means a working directory per run —
  `git worktree` from the shared clone, which is cheap since it does not copy history — plus
  artifact paths and report paths that are per-run rather than per-project. That is a milestone of
  its own, and worth doing only once someone actually wants it.
- **Priorities or reordering.** The queue is first in, first out. A "run this next" button is easy
  to add and impossible to remove.
- **Isolating lane listing from a running build.** Removing the 409 also removes the only thing
  that kept `GET /lanes` from touching a project's workspace while a build was using it. In
  practice `ensureCloned` is a no-op once the clone exists and the lane list is cached, so nothing
  is written — but it is a new interleaving, and worth knowing rather than discovering.
- **Surviving a crash mid-run.** A run that had started is marked `interrupted` on restart, as
  before. Resuming it would mean re-attaching to a process that no longer exists.

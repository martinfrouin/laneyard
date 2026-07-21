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

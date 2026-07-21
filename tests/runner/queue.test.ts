import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";
import { RunQueue } from "../../src/runner/queue.js";

function setup() {
  const runs = new RunStore(openDatabase(":memory:"));
  const enqueue = (): number =>
    runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });
  return { runs, enqueue };
}

describe("RunQueue", () => {
  it("runs queued jobs one at a time, in order", async () => {
    const { runs, enqueue } = setup();
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

    const a = enqueue();
    const b = enqueue();
    const c = enqueue();
    queue.wake();
    await queue.idle();

    expect(order).toEqual([a, b, c]);
    expect(peak).toBe(1); // the whole point
  });

  it("picks up runs that were already queued when it started", async () => {
    // No "add" call on the queue itself: a run's queued status in the
    // database is its place in line, discovered rather than pushed.
    const { runs, enqueue } = setup();
    const seen: number[] = [];
    const a = enqueue();
    const b = enqueue();

    const queue = new RunQueue(runs, async (id) => {
      seen.push(id);
      runs.finish(id, { status: "success", exitCode: 0, errorSummary: null });
    });

    queue.wake();
    await queue.idle();

    expect(seen).toEqual([a, b]);
  });

  it("keeps going after a job throws", async () => {
    // One bad run must not stall every run behind it.
    const { runs, enqueue } = setup();
    const seen: number[] = [];
    const a = enqueue();
    const b = enqueue();

    const queue = new RunQueue(runs, async (id) => {
      seen.push(id);
      if (id === a) throw new Error("boom");
      runs.finish(id, { status: "success", exitCode: 0, errorSummary: null });
    });

    queue.wake();
    await queue.idle();

    expect(seen).toEqual([a, b]);
    // The job never moved `a` out of `queued`; the queue's safety net must,
    // or the next drain iteration would read the same row forever.
    expect(runs.get(a)?.status).toBe("failed");
    expect(runs.get(a)?.errorSummary).toMatch(/unexpected/i);
    expect(runs.get(b)?.status).toBe("success");
  });

  it("cancels a queued run without ever running it", async () => {
    const { runs, enqueue } = setup();
    const ran: number[] = [];
    const a = enqueue();
    const b = enqueue();

    const queue = new RunQueue(runs, async (id) => {
      ran.push(id);
      runs.finish(id, { status: "success", exitCode: 0, errorSummary: null });
    });

    expect(queue.cancel(b)).toBe(true);
    queue.wake();
    await queue.idle();

    expect(ran).toEqual([a]);
    expect(runs.get(b)?.status).toBe("cancelled");
  });

  it("cancels the run in flight through its signal", async () => {
    const { runs, enqueue } = setup();
    const a = enqueue();
    let sawAbort = false;

    const queue = new RunQueue(runs, async (id, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          runs.finish(id, { status: "cancelled", exitCode: null, errorSummary: "Cancelled" });
          resolve();
        });
        // Cancel once the job has actually started, through the queue's own API.
        queue.cancel(a);
      });
    });

    queue.wake();
    await queue.idle();

    expect(sawAbort).toBe(true);
    expect(runs.get(a)?.status).toBe("cancelled");
  });

  it("stops accepting work once closed", async () => {
    const { runs, enqueue } = setup();
    const ran: number[] = [];
    const a = enqueue();

    const queue = new RunQueue(runs, async (id) => {
      ran.push(id);
      runs.finish(id, { status: "success", exitCode: 0, errorSummary: null });
    });

    queue.close();
    queue.wake();
    await queue.idle();

    expect(ran).toEqual([]);
    expect(runs.get(a)?.status).toBe("queued");
  });
});

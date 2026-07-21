import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";

function store(): RunStore {
  return new RunStore(openDatabase(":memory:"));
}

describe("RunStore", () => {
  it("creates a queued run and reads it back", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "beta", platform: "ios", params: { v: "1.2" } });
    const run = s.get(id);
    expect(run?.status).toBe("queued");
    expect(run?.params).toEqual({ v: "1.2" });
    expect(run?.startedAt).toBeNull();
  });

  it("timestamps the transition to running and to a terminal state", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });
    s.markRunning(id, { branch: "main", commitSha: "abc123" });
    expect(s.get(id)?.startedAt).not.toBeNull();
    expect(s.get(id)?.commitSha).toBe("abc123");

    s.finish(id, { status: "success", exitCode: 0, errorSummary: null });
    const done = s.get(id);
    expect(done?.status).toBe("success");
    expect(done?.finishedAt).not.toBeNull();
  });

  it("lists a project's runs from most recent to oldest", () => {
    const s = store();
    const a = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    const b = s.create({ projectSlug: "p", lane: "b", platform: null, params: {} });
    s.create({ projectSlug: "other", lane: "c", platform: null, params: {} });
    expect(s.listByProject("p").map((r) => r.id)).toEqual([b, a]);
  });

  it("marks any run still active as interrupted", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    s.markRunning(id, { branch: "main", commitSha: "x" });
    expect(s.interruptInFlight()).toBe(1);
    expect(s.get(id)?.status).toBe("interrupted");
    expect(s.interruptInFlight()).toBe(0);
  });

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

  it("records steps and artifacts attached to the run", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    s.replaceSteps(id, [
      { idx: 0, name: "match", durationMs: 1100, status: "success", logOffset: 42, source: "report" },
      { idx: 1, name: "build_app", durationMs: 90_000, status: "failed", logOffset: null, source: "report" },
    ]);
    s.addArtifact(id, { filename: "P.ipa", path: "/tmp/P.ipa", size: 10, kind: "ipa" });

    expect(s.steps(id)).toHaveLength(2);
    expect(s.steps(id)[1]!.status).toBe("failed");
    expect(s.artifacts(id)[0]!.kind).toBe("ipa");
  });
});

describe("CacheStore", () => {
  it("keeps payloads of different kinds apart for the same project", async () => {
    const { CacheStore } = await import("../../src/db/cache.js");
    const cache = new CacheStore(openDatabase(":memory:"));

    // Same project, same fastlane_dir hash: only the kind distinguishes them.
    // Without it the second write wins and the first reader is handed the wrong
    // shape — worse than a cache miss, because it looks like a success.
    cache.put("app", "lanes", "same-hash", [{ name: "beta" }]);
    cache.put("app", "uses", "same-hash", [{ lane: "beta", actions: [] }]);

    expect(cache.get("app", "lanes", "same-hash")).toEqual([{ name: "beta" }]);
    expect(cache.get("app", "uses", "same-hash")).toEqual([{ lane: "beta", actions: [] }]);
  });

  it("misses when the hash has moved on", async () => {
    const { CacheStore } = await import("../../src/db/cache.js");
    const cache = new CacheStore(openDatabase(":memory:"));
    cache.put("app", "lanes", "old", [1]);
    expect(cache.get("app", "lanes", "new")).toBeNull();
  });
});

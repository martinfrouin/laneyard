import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";

function store(): RunStore {
  return new RunStore(openDatabase(":memory:"));
}

describe("RunStore", () => {
  it("crée un run en attente et le relit", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "beta", platform: "ios", params: { v: "1.2" } });
    const run = s.get(id);
    expect(run?.status).toBe("queued");
    expect(run?.params).toEqual({ v: "1.2" });
    expect(run?.startedAt).toBeNull();
  });

  it("horodate le passage à running et à un état terminal", () => {
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

  it("liste les runs d'un projet du plus récent au plus ancien", () => {
    const s = store();
    const a = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    const b = s.create({ projectSlug: "p", lane: "b", platform: null, params: {} });
    s.create({ projectSlug: "autre", lane: "c", platform: null, params: {} });
    expect(s.listByProject("p").map((r) => r.id)).toEqual([b, a]);
  });

  it("marque interrompu tout run resté actif", () => {
    const s = store();
    const id = s.create({ projectSlug: "p", lane: "a", platform: null, params: {} });
    s.markRunning(id, { branch: "main", commitSha: "x" });
    expect(s.interruptActive()).toBe(1);
    expect(s.get(id)?.status).toBe("interrupted");
    expect(s.interruptActive()).toBe(0);
  });

  it("enregistre étapes et artefacts rattachés au run", () => {
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

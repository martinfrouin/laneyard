import { describe, expect, it } from "vitest";
import { RunSockets } from "../../src/server/ws.js";

interface FakeSocket {
  sent: string[];
  send(data: string): void;
}

const socket = (): FakeSocket => ({ sent: [], send(d) { this.sent.push(d); } });

describe("RunSockets", () => {
  it("broadcasts a fragment to the run's subscribers", () => {
    const hub = new RunSockets();
    const a = socket();
    hub.subscribe(1, a);

    hub.broadcast(1, "output", 10);

    expect(JSON.parse(a.sent[0]!)).toEqual({ type: "chunk", offset: 10, data: "output" });
  });

  it("sends nothing to another run's subscribers", () => {
    const hub = new RunSockets();
    const other = socket();
    hub.subscribe(2, other);

    hub.broadcast(1, "output", 0);

    expect(other.sent).toEqual([]);
  });

  it("stops writing to an unsubscribed subscriber", () => {
    const hub = new RunSockets();
    const s = socket();
    hub.subscribe(1, s);
    hub.unsubscribe(1, s);

    hub.broadcast(1, "output", 0);

    expect(s.sent).toEqual([]);
  });

  it("survives a subscriber whose send fails", () => {
    const hub = new RunSockets();
    const broken = { send() { throw new Error("closed socket"); } };
    const healthy = socket();
    hub.subscribe(1, broken);
    hub.subscribe(1, healthy);

    expect(() => hub.broadcast(1, "output", 0)).not.toThrow();
    expect(healthy.sent).toHaveLength(1);
  });

  it("announces the end of a run", () => {
    const hub = new RunSockets();
    const s = socket();
    hub.subscribe(1, s);

    hub.finish(1, "success");

    expect(JSON.parse(s.sent[0]!)).toEqual({ type: "finished", status: "success" });
  });
});

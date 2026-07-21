import { describe, expect, it } from "vitest";
import { RunSockets } from "../../src/server/ws.js";

interface FakeSocket {
  sent: string[];
  send(data: string): void;
}

const socket = (): FakeSocket => ({ sent: [], send(d) { this.sent.push(d); } });

describe("RunSockets", () => {
  it("diffuse un fragment aux abonnés du run", () => {
    const hub = new RunSockets();
    const a = socket();
    hub.subscribe(1, a);

    hub.broadcast(1, "sortie", 10);

    expect(JSON.parse(a.sent[0]!)).toEqual({ type: "chunk", offset: 10, data: "sortie" });
  });

  it("n'envoie rien aux abonnés d'un autre run", () => {
    const hub = new RunSockets();
    const autre = socket();
    hub.subscribe(2, autre);

    hub.broadcast(1, "sortie", 0);

    expect(autre.sent).toEqual([]);
  });

  it("cesse d'écrire à un abonné désinscrit", () => {
    const hub = new RunSockets();
    const s = socket();
    hub.subscribe(1, s);
    hub.unsubscribe(1, s);

    hub.broadcast(1, "sortie", 0);

    expect(s.sent).toEqual([]);
  });

  it("survit à un abonné dont l'envoi échoue", () => {
    const hub = new RunSockets();
    const cassé = { send() { throw new Error("socket fermée"); } };
    const sain = socket();
    hub.subscribe(1, cassé);
    hub.subscribe(1, sain);

    expect(() => hub.broadcast(1, "sortie", 0)).not.toThrow();
    expect(sain.sent).toHaveLength(1);
  });

  it("annonce la fin d'un run", () => {
    const hub = new RunSockets();
    const s = socket();
    hub.subscribe(1, s);

    hub.finish(1, "success");

    expect(JSON.parse(s.sent[0]!)).toEqual({ type: "finished", status: "success" });
  });
});

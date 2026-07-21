import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LogStore } from "../../src/logs/store.js";
import { tmpDir } from "../fixtures/repos.js";

describe("LogStore", () => {
  it("écrit et relit intégralement", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(1);
    await w.append("première ligne\n");
    await w.append("seconde ligne\n");
    await w.close();

    expect(await store.read(1)).toBe("première ligne\nseconde ligne\n");
  });

  it("relit depuis un décalage en octets", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(2);
    await w.append("abcdef");
    await w.close();

    expect(await store.read(2, 3)).toBe("def");
  });

  it("expose le décalage courant après chaque écriture", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(3);
    expect(w.offset).toBe(0);
    await w.append("héllo"); // 6 octets en UTF-8, pas 5
    expect(w.offset).toBe(6);
    await w.close();
  });

  it("renvoie une chaîne vide pour un run sans log", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    expect(await store.read(999)).toBe("");
  });

  it("place le fichier dans le dossier configuré", async () => {
    const dir = await tmpDir("laneyard-logs-");
    const store = new LogStore(dir);
    expect(store.pathFor(7)).toBe(join(dir, "7.log"));
  });
});

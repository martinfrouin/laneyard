import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LogStore } from "../../src/logs/store.js";
import { tmpDir } from "../fixtures/repos.js";

describe("LogStore", () => {
  it("writes and reads back in full", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(1);
    await w.append("first line\n");
    await w.append("second line\n");
    await w.close();

    expect(await store.read(1)).toBe("first line\nsecond line\n");
  });

  it("reads back from a byte offset", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(2);
    await w.append("abcdef");
    await w.close();

    expect(await store.read(2, 3)).toBe("def");
  });

  it("exposes the current offset after every write", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    const w = await store.open(3);
    expect(w.offset).toBe(0);
    await w.append("hüllo"); // 6 bytes in UTF-8, not 5
    expect(w.offset).toBe(6);
    await w.close();
  });

  it("returns an empty string for a run with no log", async () => {
    const store = new LogStore(await tmpDir("laneyard-logs-"));
    expect(await store.read(999)).toBe("");
  });

  it("places the file in the configured folder", async () => {
    const dir = await tmpDir("laneyard-logs-");
    const store = new LogStore(dir);
    expect(store.pathFor(7)).toBe(join(dir, "7.log"));
  });
});

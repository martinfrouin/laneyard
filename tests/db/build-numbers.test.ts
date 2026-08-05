import { describe, expect, it } from "vitest";
import { BuildNumberStore } from "../../src/db/build-numbers.js";
import { openDatabase } from "../../src/db/open.js";

function store(): BuildNumberStore {
  return new BuildNumberStore(openDatabase(":memory:"));
}

describe("BuildNumberStore", () => {
  it("starts a project that has never run at 1", () => {
    expect(store().next("p")).toBe(1);
  });

  it("hands out the next number and advances", () => {
    const s = store();
    expect(s.reserve("p")).toBe(1);
    expect(s.reserve("p")).toBe(2);
    expect(s.next("p")).toBe(3);
  });

  it("counts each project on its own", () => {
    const s = store();
    s.reserve("p");
    s.reserve("p");
    expect(s.reserve("other")).toBe(1);
    expect(s.reserve("p")).toBe(3);
  });

  it("sets the next number, and carries on from there", () => {
    const s = store();
    s.reserve("p");
    s.set("p", 57);
    expect(s.next("p")).toBe(57);
    expect(s.reserve("p")).toBe(57);
    expect(s.reserve("p")).toBe(58);
  });

  it("sets the next number for a project that has never run", () => {
    const s = store();
    s.set("fresh", 100);
    expect(s.reserve("fresh")).toBe(100);
  });

  it("forgets a project's counter", () => {
    const s = store();
    s.reserve("p");
    s.reserve("p");
    s.forget("p");
    expect(s.next("p")).toBe(1);
  });
});

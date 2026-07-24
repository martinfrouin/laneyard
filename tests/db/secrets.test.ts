import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";

const store = (): SecretStore => new SecretStore(openDatabase(":memory:"));

describe("SecretStore", () => {
  it("stores and lists a project secret without ever returning its value", () => {
    const s = store();
    s.set("app", "MATCH_PASSWORD", "cipher-blob", true);

    const listed = s.list("app");
    expect(listed).toEqual([{ key: "MATCH_PASSWORD", masked: true }]);
    // The listing type has no `value` at all — this is a compile-time guarantee
    // as much as a runtime one.
    expect(JSON.stringify(listed)).not.toContain("cipher-blob");
  });

  it("overwrites a secret of the same name rather than duplicating it", () => {
    const s = store();
    s.set("app", "TOKEN", "first", true);
    s.set("app", "TOKEN", "second", true);

    expect(s.list("app")).toHaveLength(1);
    expect(s.encrypted("app")["TOKEN"]).toBe("second");
  });

  it("keeps one project's secrets out of every other project", () => {
    // The property the whole scope removal exists to give: what a project holds
    // is its own, and nothing it did not store can reach its runs.
    const s = store();
    s.set("app", "TOKEN", "app-value", true);
    s.set("other", "TOKEN", "other-value", true);

    expect(s.encrypted("app")["TOKEN"]).toBe("app-value");
    expect(s.encrypted("other")["TOKEN"]).toBe("other-value");
    expect(s.list("elsewhere")).toEqual([]);
  });

  it("finds one row by name, and nothing under another project's name", () => {
    const s = store();
    s.set("app", "TOKEN", "cipher", false);

    expect(s.find("app", "TOKEN")).toEqual({ key: "TOKEN", masked: false, valueEnc: "cipher" });
    expect(s.find("other", "TOKEN")).toBeUndefined();
  });

  it("removes a secret", () => {
    const s = store();
    s.set("app", "TOKEN", "v", true);
    expect(s.remove("app", "TOKEN")).toBe(true);
    expect(s.list("app")).toEqual([]);
    expect(s.remove("app", "TOKEN")).toBe(false);
  });

  it("does not let removing one project's secret touch another's", () => {
    const s = store();
    s.set("app", "TOKEN", "app-value", true);
    s.set("other", "TOKEN", "other-value", true);

    s.remove("app", "TOKEN");
    expect(s.encrypted("other")["TOKEN"]).toBe("other-value");
  });

  it("flips masking without touching the value, and reports an unknown row", () => {
    const s = store();
    s.set("app", "TOKEN", "cipher", true);

    expect(s.setMasked("app", "TOKEN", false)).toBe(true);
    expect(s.list("app")).toEqual([{ key: "TOKEN", masked: false }]);
    expect(s.encrypted("app")["TOKEN"]).toBe("cipher");
    expect(s.setMasked("app", "ABSENT", false)).toBe(false);
  });

  it("names the masked keys, and only this project's", () => {
    const s = store();
    s.set("app", "SECRET", "c1", true);
    s.set("app", "PLAIN", "c2", false);
    s.set("other", "ELSEWHERE", "c3", true);

    expect([...s.maskedKeys("app")]).toEqual(["SECRET"]);
  });

  it("removes everything a project holds, and returns how many", () => {
    const s = store();
    s.set("app", "ONE", "c1", true);
    s.set("app", "TWO", "c2", true);
    s.set("other", "THREE", "c3", true);

    expect(s.removeAll("app")).toBe(2);
    expect(s.list("app")).toEqual([]);
    expect(s.list("other")).toHaveLength(1);
  });
});

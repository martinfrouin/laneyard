import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";

const store = (): SecretStore => new SecretStore(openDatabase(":memory:"));

describe("SecretStore", () => {
  it("stores and lists a project secret without ever returning its value", () => {
    const s = store();
    s.set("app", "MATCH_PASSWORD", "cipher-blob", true);

    const listed = s.list("app");
    expect(listed).toEqual([
      { key: "MATCH_PASSWORD", masked: true, scope: "project" },
    ]);
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

  it("keeps global secrets and project secrets apart", () => {
    const s = store();
    s.set(null, "SHARED", "global-value", true);
    s.set("app", "OWN", "project-value", true);

    expect(s.list("app").map((x) => x.key).sort()).toEqual(["OWN", "SHARED"]);
    expect(s.list("other").map((x) => x.key)).toEqual(["SHARED"]);
    expect(s.list("app").find((x) => x.key === "SHARED")?.scope).toBe("global");
  });

  it("lets a project secret win over a global one of the same name", () => {
    const s = store();
    s.set(null, "TOKEN", "global", true);
    s.set("app", "TOKEN", "project", true);

    expect(s.encrypted("app")["TOKEN"]).toBe("project");
    expect(s.encrypted("other")["TOKEN"]).toBe("global");
    // Listed once, not twice, and attributed to the scope that actually applies.
    const shown = s.list("app").filter((x) => x.key === "TOKEN");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.scope).toBe("project");
  });

  it("removes a secret", () => {
    const s = store();
    s.set("app", "TOKEN", "v", true);
    expect(s.remove("app", "TOKEN")).toBe(true);
    expect(s.list("app")).toEqual([]);
    expect(s.remove("app", "TOKEN")).toBe(false);
  });

  it("does not let removing a project secret touch the global one", () => {
    const s = store();
    s.set(null, "TOKEN", "global", true);
    s.set("app", "TOKEN", "project", true);

    s.remove("app", "TOKEN");
    expect(s.encrypted("app")["TOKEN"]).toBe("global");
  });
});

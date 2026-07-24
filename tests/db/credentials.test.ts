import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";

function store(): CredentialStore {
  return new CredentialStore(openDatabase(":memory:"));
}

describe("CredentialStore", () => {
  it("stores and finds a block", () => {
    const s = store();
    s.set("popotheque", "android_keystore", {
      fileName: "release.jks",
      fileEnc: "cipher-a",
      fieldsEnc: "cipher-b",
      varNames: { path: "ANDROID_KEYSTORE_PATH" },
    });

    const found = s.find("popotheque", "android_keystore");
    expect(found).toMatchObject({
      kind: "android_keystore",
      fileName: "release.jks",
      fileEnc: "cipher-a",
      varNames: { path: "ANDROID_KEYSTORE_PATH" },
    });
  });

  it("keeps one project's blocks out of every other project", () => {
    const s = store();
    s.set("popotheque", "apple_asc", { fileName: "p.p8", fileEnc: "p", fieldsEnc: "p", varNames: {} });

    expect(s.find("popotheque", "apple_asc")?.fileName).toBe("p.p8");
    expect(s.find("autre", "apple_asc")).toBeUndefined();
    expect(s.list("autre")).toEqual([]);
  });

  it("overwrites a block of the same kind rather than duplicating it", () => {
    const s = store();
    s.set("app", "apple_asc", { fileName: "first.p8", fileEnc: "a", fieldsEnc: "a", varNames: {} });
    s.set("app", "apple_asc", { fileName: "second.p8", fileEnc: "b", fieldsEnc: "b", varNames: {} });

    expect(s.list("app")).toHaveLength(1);
    expect(s.find("app", "apple_asc")?.fileName).toBe("second.p8");
  });

  it("reports whether a removal happened", () => {
    const s = store();
    s.set("app", "play_service_account", { fileName: "a.json", fileEnc: "x", fieldsEnc: "y", varNames: {} });
    expect(s.remove("app", "play_service_account")).toBe(true);
    expect(s.remove("app", "play_service_account")).toBe(false);
  });

  it("removes everything a project holds, and returns how many", () => {
    const s = store();
    s.set("app", "android_keystore", { fileName: "p.jks", fileEnc: "p", fieldsEnc: "p", varNames: {} });
    s.set("app", "apple_asc", { fileName: "p.p8", fileEnc: "p", fieldsEnc: "p", varNames: {} });
    s.set("other", "play_service_account", { fileName: "o.json", fileEnc: "o", fieldsEnc: "o", varNames: {} });

    expect(s.removeAll("app")).toBe(2);
    expect(s.list("app")).toEqual([]);
    expect(s.list("other")).toHaveLength(1);
  });

  it("keeps no ciphertext in a listing", () => {
    const s = store();
    s.set("app", "apple_asc", { fileName: "a.p8", fileEnc: "file-cipher", fieldsEnc: "fields-cipher", varNames: {} });

    expect(JSON.stringify(s.list("app"))).not.toContain("cipher");
  });
});

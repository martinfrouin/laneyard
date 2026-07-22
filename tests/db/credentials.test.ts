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
      scope: "project",
      varNames: { path: "ANDROID_KEYSTORE_PATH" },
    });
  });

  it("lets a project block shadow a global one of the same kind", () => {
    const s = store();
    s.set(null, "apple_asc", { fileName: "g.p8", fileEnc: "g", fieldsEnc: "g", varNames: {} });
    s.set("popotheque", "apple_asc", { fileName: "p.p8", fileEnc: "p", fieldsEnc: "p", varNames: {} });

    expect(s.find("popotheque", "apple_asc")?.fileName).toBe("p.p8");
    expect(s.find("autre", "apple_asc")?.fileName).toBe("g.p8");
    expect(s.applicable("popotheque")).toHaveLength(1);
  });

  it("reports whether a removal happened", () => {
    const s = store();
    s.set(null, "play_service_account", { fileName: "a.json", fileEnc: "x", fieldsEnc: "y", varNames: {} });
    expect(s.remove(null, "play_service_account")).toBe(true);
    expect(s.remove(null, "play_service_account")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_KINDS,
  defaultVarNames,
  exportedVarNames,
  fieldsOf,
} from "../../src/credentials/kinds.js";

describe("credential kinds", () => {
  it("defaults Apple to the names fastlane itself reads", () => {
    expect(defaultVarNames("apple_asc")).toEqual({
      path: "APP_STORE_CONNECT_API_KEY_KEY_FILEPATH",
      key_id: "APP_STORE_CONNECT_API_KEY_KEY_ID",
      issuer_id: "APP_STORE_CONNECT_API_KEY_ISSUER_ID",
    });
  });

  it("gives the keystore a password name readiness already recognises", () => {
    // heuristics/readiness.ts:466 matches /(^|_)(KEYSTORE|STORE)_PASSWORD$/.
    // The block and the check must agree by construction, not by luck.
    expect(defaultVarNames("android_keystore").store_password).toMatch(
      /(^|_)(KEYSTORE|STORE)_PASSWORD$/,
    );
  });

  it("knows which fields are secret", () => {
    const fields = fieldsOf("android_keystore");
    expect(fields.find((f) => f.name === "store_password")?.secret).toBe(true);
    expect(fields.find((f) => f.name === "key_alias")?.secret).toBe(false);
  });

  it("covers every kind", () => {
    expect(CREDENTIAL_KINDS).toHaveLength(3);
  });
});

describe("exportedVarNames", () => {
  it("falls back to the kind's defaults for a slot the block does not rename", () => {
    // A block stored before a slot existed carries no name for it, and the run
    // exports the default. What is counted must be what is exported.
    expect(exportedVarNames([{ kind: "apple_asc", varNames: { key_id: "ASC_KEY_ID" } }])).toEqual([
      "APP_STORE_CONNECT_API_KEY_ISSUER_ID",
      "APP_STORE_CONNECT_API_KEY_KEY_FILEPATH",
      "ASC_KEY_ID",
    ]);
  });

  it("gathers every block, without repeating a name two of them share", () => {
    expect(
      exportedVarNames([
        { kind: "play_service_account", varNames: { path: "SHARED" } },
        { kind: "apple_asc", varNames: { path: "SHARED", key_id: "K", issuer_id: "I" } },
      ]),
    ).toEqual(["I", "K", "SHARED"]);
  });

  it("is empty when nothing is stored", () => {
    expect(exportedVarNames([])).toEqual([]);
  });
});

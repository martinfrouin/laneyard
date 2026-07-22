import { describe, expect, it } from "vitest";
import { CredentialStore } from "../../src/db/credentials.js";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";
import { exportedVarNames } from "../../src/credentials/kinds.js";
import { Vault } from "../../src/secrets/vault.js";
import { requiredSecrets } from "../../src/server/required-secrets.js";
import { tmpDir } from "../fixtures/repos.js";

/**
 * A name a signing block supplies is a name the project has.
 *
 * The vault, the server's environment and the blocks are three ways the same
 * variable reaches a run, and only the first two used to count. The result was
 * a screen asking someone to type by hand the `.p8` path Laneyard was about to
 * write for them.
 */
async function vault() {
  const db = openDatabase(":memory:");
  return Vault.open(await tmpDir("laneyard-required-"), new SecretStore(db), new CredentialStore(db));
}

const JSON_KEY = Buffer.from('{"type":"service_account"}');

/** Everything but the names, which is what each case here varies. */
const ask = (lanes: string[], blockNames: string[], vaultKeys: string[] = []) =>
  requiredSecrets({
    lanes: [{ lane: "beta", actions: [], env: lanes }],
    declared: [],
    // A directory with no `.env.example` in it: this module reads nothing else.
    workspacePath: "/nonexistent",
    fastlaneDir: "fastlane",
    vaultKeys,
    blockNames,
    serverEnv: [],
  });

describe("requiredSecrets", () => {
  it("does not ask for a name a block already supplies", async () => {
    const v = await vault();
    await v.setCredential("sample", "play_service_account", {
      fileName: "play.json",
      fileBytes: JSON_KEY,
      fields: {},
      varNames: { path: "SUPPLY_JSON_KEY" },
    });

    const answer = await ask(["SUPPLY_JSON_KEY"], exportedVarNames(v.listCredentials("sample")));
    expect(answer.required).toEqual(["SUPPLY_JSON_KEY"]);
    expect(answer.missing).toEqual([]);
  });

  it("still asks for a name nothing supplies", async () => {
    const v = await vault();
    await v.setCredential("sample", "play_service_account", {
      fileName: "play.json",
      fileBytes: JSON_KEY,
      fields: {},
      varNames: { path: "SUPPLY_JSON_KEY" },
    });

    const answer = await ask(
      ["SUPPLY_JSON_KEY", "SENTRY_AUTH_TOKEN"],
      exportedVarNames(v.listCredentials("sample")),
    );
    expect(answer.missing).toEqual(["SENTRY_AUTH_TOKEN"]);
  });

  it("counts a project block over a global one", async () => {
    const v = await vault();
    // The same kind stored twice under different names. A run resolves the
    // project's own and exports `PROJECT_JSON_KEY`; anything that answered from
    // the global block would tick a name no run will ever set.
    await v.setCredential(null, "play_service_account", {
      fileName: "global.json",
      fileBytes: JSON_KEY,
      fields: {},
      varNames: { path: "GLOBAL_JSON_KEY" },
    });
    await v.setCredential("sample", "play_service_account", {
      fileName: "project.json",
      fileBytes: JSON_KEY,
      fields: {},
      varNames: { path: "PROJECT_JSON_KEY" },
    });

    const names = exportedVarNames(v.listCredentials("sample"));
    expect(names).toEqual(["PROJECT_JSON_KEY"]);

    const answer = await ask(["PROJECT_JSON_KEY", "GLOBAL_JSON_KEY"], names);
    expect(answer.missing).toEqual(["GLOBAL_JSON_KEY"]);
  });

  it("counts a global block where the project has none of that kind", async () => {
    const v = await vault();
    await v.setCredential(null, "play_service_account", {
      fileName: "global.json",
      fileBytes: JSON_KEY,
      fields: {},
      varNames: { path: "GLOBAL_JSON_KEY" },
    });

    const answer = await ask(["GLOBAL_JSON_KEY"], exportedVarNames(v.listCredentials("sample")));
    expect(answer.missing).toEqual([]);
  });

  it("counts every name a block exports, not only the file's", async () => {
    const v = await vault();
    await v.setCredential("sample", "apple_asc", {
      fileName: "AuthKey_ABC123.p8",
      fileBytes: Buffer.from("-----BEGIN PRIVATE KEY-----"),
      fields: { key_id: "ABC123", issuer_id: "1234-5678" },
      varNames: {
        path: "ASC_KEY_FILEPATH",
        key_id: "ASC_KEY_ID",
        issuer_id: "ASC_ISSUER_ID",
      },
    });

    const answer = await ask(
      ["ASC_KEY_FILEPATH", "ASC_KEY_ID", "ASC_ISSUER_ID"],
      exportedVarNames(v.listCredentials("sample")),
    );
    expect(answer.missing).toEqual([]);
  });

  it("still counts a vault key and a server variable", async () => {
    const answer = await requiredSecrets({
      lanes: [{ lane: "beta", actions: [], env: ["IN_VAULT", "IN_SERVER", "NOWHERE"] }],
      declared: [],
      workspacePath: "/nonexistent",
      fastlaneDir: "fastlane",
      vaultKeys: ["IN_VAULT"],
      blockNames: [],
      serverEnv: ["IN_SERVER"],
    });
    expect(answer.missing).toEqual(["NOWHERE"]);
  });
});

import { readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultVarNames } from "../../src/credentials/kinds.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";
import { SecretStore } from "../../src/db/secrets.js";
import { LogStore } from "../../src/logs/store.js";
import { materialiseCredentials } from "../../src/runner/materialise.js";
import { executeRun } from "../../src/runner/orchestrate.js";
import { Vault } from "../../src/secrets/vault.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

const P8 = Buffer.from("-----BEGIN PRIVATE KEY-----\nnot-really\n");
const KEYSTORE = Buffer.from([0xfe, 0xed, 0x00, 0xff, 0x80, 0x7f]);

const KEYSTORE_FIELDS = {
  key_alias: "upload",
  store_password: "correct-horse-battery",
  key_password: "staple-battery-horse",
};

async function vault(): Promise<Vault> {
  const db = openDatabase(":memory:");
  return Vault.open(await tmpDir("laneyard-materialise-"), new SecretStore(db), new CredentialStore(db));
}

/** The mode bits, without the file-type bits `stat` mixes into `mode`. */
function permissions(mode: number): number {
  return mode & 0o777;
}

describe("materialiseCredentials", () => {
  it("writes each block and exports the path it was configured under", async () => {
    const v = await vault();
    await v.setCredential("app", "apple_asc", {
      fileName: "AuthKey_ABC123.p8",
      fileBytes: P8,
      fields: { key_id: "ABC123", issuer_id: "69a6de70" },
      varNames: { ...defaultVarNames("apple_asc"), path: "ASC_KEY_FILEPATH" },
    });

    const dir = join(await tmpDir("laneyard-run-"), "secrets");
    const { env } = await materialiseCredentials(v, "app", dir);

    const path = env["ASC_KEY_FILEPATH"]!;
    expect(path).toBeDefined();
    expect((await readFile(path)).equals(P8)).toBe(true);
  });

  it("uses the overridden name and not the default one", async () => {
    // A project that reads a private variable name is not a project doing it
    // wrong: exporting the default alongside would paper over a rename the user
    // asked for, and hide the mistake when they got the name wrong.
    const v = await vault();
    await v.setCredential("app", "apple_asc", {
      fileName: "AuthKey_ABC123.p8",
      fileBytes: P8,
      fields: { key_id: "ABC123", issuer_id: "69a6de70" },
      varNames: { ...defaultVarNames("apple_asc"), path: "ASC_KEY_FILEPATH" },
    });

    const dir = join(await tmpDir("laneyard-run-"), "secrets");
    const { env } = await materialiseCredentials(v, "app", dir);

    expect(env["ASC_KEY_FILEPATH"]).toBeDefined();
    expect(env["APP_STORE_CONNECT_API_KEY_KEY_FILEPATH"]).toBeUndefined();
  });

  it("leaves the files readable by their owner alone", async () => {
    const v = await vault();
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: KEYSTORE,
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });

    const dir = join(await tmpDir("laneyard-run-"), "secrets");
    const { env } = await materialiseCredentials(v, "app", dir);

    expect(permissions((await stat(dir)).mode)).toBe(0o700);
    expect(permissions((await stat(env["ANDROID_KEYSTORE_PATH"]!)).mode)).toBe(0o600);
  });

  it("exports the fields that are not a path as well", async () => {
    const v = await vault();
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: KEYSTORE,
      fields: KEYSTORE_FIELDS,
      varNames: { ...defaultVarNames("android_keystore"), key_alias: "UPLOAD_ALIAS" },
    });

    const dir = join(await tmpDir("laneyard-run-"), "secrets");
    const { env } = await materialiseCredentials(v, "app", dir);

    expect(env["UPLOAD_ALIAS"]).toBe("upload");
    expect(env["ANDROID_KEY_ALIAS"]).toBeUndefined();
    expect(env["ANDROID_KEYSTORE_PASSWORD"]).toBe(KEYSTORE_FIELDS.store_password);
    expect(env["ANDROID_KEY_PASSWORD"]).toBe(KEYSTORE_FIELDS.key_password);
  });

  it("materialises every applicable block, not only the ones a lane looks like it needs", async () => {
    const v = await vault();
    await v.setCredential("app", "play_service_account", {
      fileName: "play.json",
      fileBytes: Buffer.from('{"type":"service_account"}'),
      fields: {},
      varNames: defaultVarNames("play_service_account"),
    });
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: KEYSTORE,
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });

    const dir = join(await tmpDir("laneyard-run-"), "secrets");
    const { env } = await materialiseCredentials(v, "app", dir);

    expect(env["SUPPLY_JSON_KEY"]).toBeDefined();
    expect(env["ANDROID_KEYSTORE_PATH"]).toBeDefined();
  });

  it("leaves nothing behind once the run is over", async () => {
    const v = await vault();
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: KEYSTORE,
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });

    const dir = join(await tmpDir("laneyard-run-"), "secrets");
    const { cleanup } = await materialiseCredentials(v, "app", dir);
    expect(existsSync(dir)).toBe(true);

    await cleanup();
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses to run rather than skip a block that will not decrypt", async () => {
    // A keystore quietly left out costs a debug-signed artifact that builds,
    // uploads, and is rejected days later by the store.
    const db = openDatabase(":memory:");
    const v = await Vault.open(
      await tmpDir("laneyard-materialise-"),
      new SecretStore(db),
      new CredentialStore(db),
    );
    await v.setCredential("app", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: KEYSTORE,
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });
    db.prepare("UPDATE credential SET file_enc = ? WHERE kind = ?").run("v1.aaaa.bbbb.cccc", "android_keystore");

    const dir = join(await tmpDir("laneyard-run-"), "secrets");
    await expect(materialiseCredentials(v, "app", dir)).rejects.toThrow(/android_keystore/);
  });
});

describe("executeRun cleanup", () => {
  it("removes the secrets directory even when the lane fails", async () => {
    const origin = await makeOriginRepo({
      "fastlane/Fastfile": "lane :beta do\nend\n",
      ".gitignore": "build/\n",
    });
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    const secretsDir = join(root, "runs", String(runId), "secrets");
    const v = await vault();
    await v.setCredential("p", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: KEYSTORE,
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });
    const { env, cleanup } = await materialiseCredentials(v, "p", secretsDir);

    const result = await executeRun({
      runId,
      runs,
      logs,
      workspacePath: join(root, "workspaces", "p"),
      artifactsDir: join(root, "artifacts", String(runId)),
      gitUrl: origin,
      branch: "main",
      resolveSettings: async () => ({
        fastlane_dir: "fastlane",
        runtime: "system" as const,
        timeout_minutes: 5,
        interactive_default: false,
        artifact_globs: [],
        required_secrets: [],
      }),
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"]}`, FAKE_FASTLANE_SCENARIO: "failure" },
      credentialEnv: env,
      cleanup,
      onChunk: () => {},
    });

    expect(result.status).toBe("failed");
    expect(existsSync(secretsDir)).toBe(false);
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it("removes the secrets directory when the run never reaches fastlane", async () => {
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    const secretsDir = join(root, "runs", String(runId), "secrets");
    const v = await vault();
    await v.setCredential("p", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: KEYSTORE,
      fields: KEYSTORE_FIELDS,
      varNames: defaultVarNames("android_keystore"),
    });
    const { env, cleanup } = await materialiseCredentials(v, "p", secretsDir);

    // The clone fails, so `executeRun` returns from one of its early exits —
    // the paths that had no cleanup to run before this task.
    const result = await executeRun({
      runId,
      runs,
      logs,
      workspacePath: join(root, "ws"),
      artifactsDir: join(root, "art"),
      gitUrl: "/nexiste/pas/depot.git",
      branch: "main",
      resolveSettings: async () => {
        throw new Error("unreachable");
      },
      env: {},
      credentialEnv: env,
      cleanup,
      onChunk: () => {},
    });

    expect(result.status).toBe("failed");
    expect(existsSync(secretsDir)).toBe(false);
    await rm(root, { recursive: true, force: true });
  }, 60_000);
});

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultVarNames } from "../../src/credentials/kinds.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { openDatabase } from "../../src/db/open.js";
import { RunStore } from "../../src/db/runs.js";
import { SecretStore } from "../../src/db/secrets.js";
import { findAndroidBuild } from "../../src/heuristics/android-root.js";
import { LogStore } from "../../src/logs/store.js";
import { materialiseCredentials } from "../../src/runner/materialise.js";
import { executeRun } from "../../src/runner/orchestrate.js";
import { Vault } from "../../src/secrets/vault.js";
import {
  LANEYARD_MARKER,
  removeGradleProperties,
  sweepGradleProperties,
  writeGradleProperties,
} from "../../src/runner/gradle-properties.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

/** The Flutter documentation's own snippet, which is the reason this module exists. */
const FLUTTER = `
val keystorePropertiesFile = rootProject.file("key.properties")

android {
    signingConfigs { create("release") { } }
    buildTypes {
        release {
            signingConfig = if (keystorePropertiesFile.exists()) signingConfigs.getByName("release")
                            else signingConfigs.getByName("debug")
        }
    }
}
`;

/** The same build, having made up its mind: the release key or nothing. */
const SIGNED = `
android {
    signingConfigs { create("release") { } }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}
`;

const BLOCK = {
  storeFile: "/var/laneyard/runs/7/secrets/android_keystore/upload.jks",
  fields: {
    key_alias: "upload",
    store_password: "correct-horse-battery",
    key_password: "staple-battery-horse",
  } as Record<string, string>,
};

async function project(files: Record<string, string>): Promise<string> {
  const root = await tmpDir("laneyard-gradle-");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text, "utf8");
  }
  return root;
}

const read = (path: string): Promise<string> => readFile(path, "utf8");

describe("writeGradleProperties", () => {
  it("writes the four documented keys under the marker", async () => {
    const root = await project({ "android/app/build.gradle.kts": FLUTTER });

    const path = await writeGradleProperties(root, BLOCK);

    expect(path).toBe(join(root, "android", "key.properties"));
    const lines = (await read(path!)).split("\n");
    expect(lines[0]).toBe(LANEYARD_MARKER);
    expect(lines).toContain(`storeFile=${BLOCK.storeFile}`);
    expect(lines).toContain("storePassword=correct-horse-battery");
    expect(lines).toContain("keyPassword=staple-battery-horse");
    expect(lines).toContain("keyAlias=upload");
  });

  it("writes nothing when the build does not fall back to the debug key", async () => {
    // Nothing to rescue: this build either signs with the release config or
    // fails, which is a project that already gets a truthful answer.
    const root = await project({ "android/app/build.gradle.kts": SIGNED });

    expect(await writeGradleProperties(root, BLOCK)).toBeNull();
    expect(existsSync(join(root, "android", "key.properties"))).toBe(false);
  });

  it("writes nothing when no keystore block applies", async () => {
    const root = await project({ "android/app/build.gradle.kts": FLUTTER });

    expect(await writeGradleProperties(root, undefined)).toBeNull();
    expect(existsSync(join(root, "android", "key.properties"))).toBe(false);
  });

  it("never touches a file it did not write", async () => {
    // Possibly the user's real signing configuration, left in the clone on
    // purpose. Overwriting it would be worse than any warning.
    const root = await project({
      "android/app/build.gradle.kts": FLUTTER,
      "android/key.properties": "storeFile=/keys/theirs.jks\n",
    });

    expect(await writeGradleProperties(root, BLOCK)).toBeNull();
    expect(await read(join(root, "android", "key.properties"))).toBe("storeFile=/keys/theirs.jks\n");
  });

  it("honours the property names the project actually reads", async () => {
    const root = await project({ "android/app/build.gradle.kts": FLUTTER });
    const path = await writeGradleProperties(root, {
      ...BLOCK,
      fields: { ...BLOCK.fields, property_names: "storeFile,storePassword,keyPassword,alias" },
    });

    const text = await read(path!);
    expect(text).toContain("alias=upload");
    expect(text).not.toContain("keyAlias=");
  });

  it("puts the file where the block says when the parser could not tell", async () => {
    const root = await project({
      "android/app/build.gradle.kts": FLUTTER.replace("rootProject.file", "keystoreDir.file"),
    });

    const path = await writeGradleProperties(root, {
      ...BLOCK,
      fields: { ...BLOCK.fields, properties_path: "android/secrets/key.properties" },
    });

    expect(path).toBe(join(root, "android", "secrets", "key.properties"));
    expect((await read(path!)).startsWith(LANEYARD_MARKER)).toBe(true);
  });

  it("leaves an unplaceable file unwritten rather than guessing", async () => {
    const root = await project({
      "android/app/build.gradle.kts": FLUTTER.replace("rootProject.file", "keystoreDir.file"),
    });

    expect(await writeGradleProperties(root, BLOCK)).toBeNull();
  });

  it("writes a file only its owner can read", async () => {
    const root = await project({ "android/app/build.gradle.kts": FLUTTER });
    const path = await writeGradleProperties(root, BLOCK);

    expect((await stat(path!)).mode & 0o777).toBe(0o600);
  });
});

describe("sweepGradleProperties", () => {
  it("removes a marked leftover from a run that was killed", async () => {
    const root = await project({
      "android/app/build.gradle.kts": FLUTTER,
      "android/key.properties": `${LANEYARD_MARKER}\nstorePassword=still-here\n`,
    });

    await sweepGradleProperties(root, BLOCK);

    expect(existsSync(join(root, "android", "key.properties"))).toBe(false);
  });

  it("does not sweep a file it did not write", async () => {
    const root = await project({
      "android/app/build.gradle.kts": FLUTTER,
      "android/key.properties": "storeFile=/keys/theirs.jks\n",
    });

    await sweepGradleProperties(root, BLOCK);

    expect(await read(join(root, "android", "key.properties"))).toBe("storeFile=/keys/theirs.jks\n");
  });

  it("is quiet about a workspace that was never cloned", async () => {
    await expect(sweepGradleProperties(join(await tmpDir(), "nowhere"), BLOCK)).resolves.toBeUndefined();
  });
});

describe("removeGradleProperties", () => {
  it("removes what the run wrote and leaves anything else", async () => {
    const root = await project({ "android/app/build.gradle.kts": FLUTTER });
    const ours = await writeGradleProperties(root, BLOCK);
    await removeGradleProperties(ours);
    expect(existsSync(ours!)).toBe(false);

    const theirs = join(root, "android", "theirs.properties");
    await writeFile(theirs, "storeFile=/keys/theirs.jks\n", "utf8");
    await removeGradleProperties(theirs);
    expect(existsSync(theirs)).toBe(true);
  });
});

describe("a run that needs the file", () => {
  const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");
  const SETTINGS = {
    fastlane_dir: "fastlane",
    runtime: "system" as const,
    timeout_minutes: 5,
    interactive_default: false,
    artifact_globs: [],
    required_secrets: [],
  };

  /**
   * A whole run against a repository that carries the Flutter snippet, with the
   * fake fastlane printing what gradle would have read.
   */
  async function run(repo: Record<string, string>): Promise<{ log: string; workspace: string }> {
    const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n", ...repo });
    const root = await tmpDir("laneyard-root-");
    const runs = new RunStore(openDatabase(":memory:"));
    const logs = new LogStore(join(root, "logs"));
    const runId = runs.create({ projectSlug: "p", lane: "beta", platform: null, params: {} });

    const db = openDatabase(":memory:");
    const vault = await Vault.open(root, new SecretStore(db), new CredentialStore(db));
    await vault.setCredential("p", "android_keystore", {
      fileName: "upload.jks",
      fileBytes: Buffer.from([0xfe, 0xed, 0x00, 0xff]),
      fields: {
        key_alias: "upload",
        store_password: "correct-horse-battery",
        key_password: "staple-battery-horse",
      },
      varNames: defaultVarNames("android_keystore"),
    });

    const workspace = join(root, "workspaces", "p");
    const materialised = await materialiseCredentials(vault, "p", join(root, "runs", String(runId), "secrets"));

    await executeRun({
      runId,
      runs,
      logs,
      workspacePath: workspace,
      artifactsDir: join(root, "artifacts", String(runId)),
      gitUrl: origin,
      branch: "main",
      resolveSettings: async () => SETTINGS,
      env: {
        PATH: `${FAKE_DIR}:${process.env["PATH"]}`,
        FAKE_FASTLANE_CAT: join(workspace, "android", "key.properties"),
      },
      credentialEnv: materialised.env,
      androidKeystore: materialised.keystore,
      cleanup: materialised.cleanup,
      maskedValues: vault.maskedValues("p"),
      onChunk: () => {},
    });

    const log = await logs.read(runId);
    await rm(origin, { recursive: true, force: true });
    return { log, workspace };
  }

  it("supplies it to the build and takes it away again", async () => {
    const { log, workspace } = await run({ "android/app/build.gradle.kts": FLUTTER });

    // What gradle would have read, printed from inside the run: the passwords
    // are redacted in the log, as everything secret is, and the two lines that
    // survive are enough to say the file was there and was Laneyard's.
    expect(log).toContain(LANEYARD_MARKER);
    expect(log).toContain("keyAlias=upload");
    expect(log).not.toContain("correct-horse-battery");

    // And nothing left behind in a clone that is kept between runs.
    expect(existsSync(join(workspace, "android", "key.properties"))).toBe(false);
  }, 60_000);

  it("sweeps what a killed run left in the clone", async () => {
    // Committed to the repository, which is the harshest version of the case:
    // the sweep removes it, the run writes its own, and the clone comes out
    // holding neither. A file the user committed themselves is protected by the
    // marker, not by the run leaving it alone.
    const { log, workspace } = await run({
      "android/app/build.gradle.kts": FLUTTER,
      "android/key.properties": `${LANEYARD_MARKER}\nkeyAlias=from-a-run-that-died\n`,
    });

    expect(log).not.toContain("from-a-run-that-died");
    expect(existsSync(join(workspace, "android", "key.properties"))).toBe(false);
  }, 60_000);

  it("leaves the project's own file to the build", async () => {
    const theirs = "storeFile=/keys/theirs.jks\nkeyAlias=theirs\n";
    const { log, workspace } = await run({
      "android/app/build.gradle.kts": FLUTTER,
      "android/key.properties": theirs,
    });

    expect(log).toContain("keyAlias=theirs");
    expect(await read(join(workspace, "android", "key.properties"))).toBe(theirs);
  }, 60_000);
});

describe("the build script the runner and the checklist agree on", () => {
  it("is the same one when the repository offers two candidates", async () => {
    // A repository that is both a Flutter app and, one directory up, an Android
    // project of its own. If the runner ran its own search and stopped at the
    // other candidate, it would write the file where the checklist is not
    // looking — a build signed by the debug key while reporting green.
    const root = await project({
      "android/app/build.gradle.kts": FLUTTER,
      "app/build.gradle": SIGNED,
    });

    const found = await findAndroidBuild(root);
    expect(found?.scriptPath).toBe(join(root, "android", "app", "build.gradle.kts"));

    const path = await writeGradleProperties(root, BLOCK);
    expect(path).toBe(join(found!.gradleRoot, "key.properties"));
  });
});

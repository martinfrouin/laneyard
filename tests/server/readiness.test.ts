import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import { buildApp } from "../../src/server/app.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import type { Check, ReadinessSection } from "../../src/heuristics/readiness.js";
import { LANEYARD_MARKER } from "../../src/runner/gradle-properties.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

/**
 * Every case here clones a real repository and asks a real git for its
 * branches. That is the point — the checklist shells out — and it is also why
 * five seconds is not enough when the whole suite runs at once.
 */
const SLOW = 60_000;

const FASTFILE = "lane :beta do\n  match(readonly: false)\nend\n";

const USES = {
  lanes: [{ lane: "beta", actions: [{ name: "match", args: { readonly: false } }] }],
  imports: false,
};

/** The Flutter documentation's own snippet: the trap `release-signing` exists to catch. */
const FLUTTER_KTS = `
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")

android {
    signingConfigs {
        create("release") { }
    }
    buildTypes {
        release {
            signingConfig = if (keystorePropertiesFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}
`;

const GRADLE_USES = {
  lanes: [{ lane: "beta", actions: [{ name: "gradle", args: { task: "assemble" } }] }],
  imports: false,
};

async function harness(
  options: { gitUrl?: string; uses?: () => Promise<unknown>; files?: Record<string, string> } = {},
) {
  const origin = await makeOriginRepo({
    "fastlane/Fastfile": FASTFILE,
    // An Xcode project by default, so the iOS section applies: most cases below
    // are about match and App Store Connect, and a repository with no platform
    // at all would not be shown either of them.
    ...(options.files ?? { "Sample.xcodeproj/project.pbxproj": "" }),
  });
  const root = await tmpDir("laneyard-readiness-");
  const configPath = join(root, "config.yml");
  await writeFile(
    configPath,
    `
server:
  users:
    - { name: admin, role: admin, password_hash: "${hashPassword("secret")}" }
projects:
  - slug: sample
    name: Sample
    git_url: ${options.gitUrl ?? origin}
`,
    "utf8",
  );

  const config = new ConfigStore(configPath);
  await config.load();
  const db = openDatabase(":memory:");

  const uses = vi.fn(options.uses ?? (async () => USES));

  const app = await buildApp({
    config,
    db,
    root,
    lanes: async () => [{ name: "beta", platform: "ios", description: "Beta", private: false }],
    uses: uses as never,
    vault: await Vault.open(root, new SecretStore(db), new CredentialStore(db)),
  });

  return { app, root, uses };
}

async function login(app: Awaited<ReturnType<typeof harness>>["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { name: "admin", password: "secret" },
  });
  return res.cookies[0]!.value;
}

interface Report {
  checkedAt: string;
  sections: ReadinessSection[];
}

/** Every line on the screen, whichever section it is under. */
const allChecks = (body: Report): Check[] => body.sections.flatMap((s) => s.checks);

const byId = (checks: Check[], id: string): Check => checks.find((c) => c.id === id)!;

describe("readiness API", () => {
  it("refuses without a session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness" });
    expect(res.statusCode).toBe(401);
  }, SLOW);

  it("404s on an unknown project", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/readiness", cookies });
    expect(res.statusCode).toBe(404);
  }, SLOW);

  it("returns the shared and iOS checks, and when they were run", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Report;
    expect(body.sections.map((s) => s.platform)).toEqual(["all", "ios"]);
    // Three shared, one of them the variables the lanes read, plus the two iOS.
    expect(allChecks(body)).toHaveLength(6);
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    // The repository is a real local clone source: it answers without a password.
    expect(byId(allChecks(body), "repository").state).toBe("ok");
  }, SLOW);

  it("reports a lane that calls match with readonly: false and no MATCH_PASSWORD", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    const checks = allChecks(res.json() as Report);
    const match = byId(checks, "match");
    expect(match.state).toBe("warn");
    expect(match.detail).toMatch(/MATCH_PASSWORD/);
    expect(byId(checks, "blocking-actions").state).toBe("warn");
  }, SLOW);

  it("changes its answer once the secret is stored", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/MATCH_PASSWORD",
      cookies,
      payload: { value: "a-long-enough-passphrase" },
    });

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    const match = byId(allChecks(res.json() as Report), "match");
    // Still a warning, but a different one: the passphrase is there, the call
    // is not readonly. The checklist moved on to the next thing.
    expect(match.state).toBe("warn");
    expect(match.detail).toMatch(/readonly: false/);
    expect(match.detail).not.toMatch(/MATCH_PASSWORD is not/);
  }, SLOW);

  it("does not fail as a whole when the sidecar cannot read the lanes", async () => {
    const { app } = await harness({
      uses: async () => {
        throw new Error("Ruby cannot load fastlane");
      },
    });
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    expect(res.statusCode).toBe(200);
    const checks = allChecks(res.json() as Report);
    expect(byId(checks, "match").state).toBe("unknown");
    expect(byId(checks, "match").detail).toMatch(/Ruby cannot load fastlane/);
    expect(byId(checks, "blocking-actions").state).toBe("unknown");
    // The checks that do not depend on the sidecar are unaffected.
    expect(byId(checks, "repository").state).toBe("ok");
  }, SLOW);

  it("says it could not tell, rather than lying, when the workspace is unreachable", async () => {
    const { app } = await harness({ gitUrl: "/nonexistent/laneyard-not-a-repo.git" });
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Report;
    const checks = allChecks(body);
    expect(byId(checks, "repository").state).toBe("warn");
    expect(byId(checks, "dependencies").state).toBe("unknown");
    // No clone means no way to see what this project builds for either — and
    // "no platform detected" would be a claim about a repository never read.
    expect(body.sections.map((s) => s.platform)).toEqual(["all"]);
    expect(byId(checks, "platforms").state).toBe("unknown");
    // The clone's own words, repository URL redacted as everywhere else.
    expect(byId(checks, "platforms").detail).toMatch(/could not tell: git clone/);
    expect(byId(checks, "platforms").fix).toMatch(/laneyard\.yml/);
  }, SLOW);

  it("shows the Android checks, and none of the iOS ones, on a Gradle project", async () => {
    // The defect this whole section exists for: an Android project told off for
    // having no App Store Connect key. One irrelevant warning teaches someone
    // to ignore the entire screen.
    const { app } = await harness({
      files: { "app/build.gradle": "" },
      uses: async () => ({ lanes: [{ lane: "beta", actions: [{ name: "gradle", args: { task: "assemble" } }] }], imports: false }),
    });
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    const body = res.json() as Report;
    expect(body.sections.map((s) => s.platform)).toEqual(["all", "android"]);
    const ids = allChecks(body).map((c) => c.id);
    expect(ids).toContain("android-keystore");
    expect(ids).toContain("play-store");
    expect(ids).not.toContain("app-store-connect");
    expect(ids).not.toContain("match");
  }, SLOW);

  it("takes laneyard.yml's word over what the repository looks like", async () => {
    // An Xcode project in the repository, and a laneyard.yml that says this is
    // an Android build. The file wins: it was written on purpose.
    const { app } = await harness({
      files: { "Sample.xcodeproj/project.pbxproj": "", "laneyard.yml": "platforms: [android]\n" },
      uses: async () => ({ lanes: [{ lane: "beta", actions: [{ name: "gradle", args: {} }] }], imports: false }),
    });
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    const body = res.json() as Report;
    expect(body.sections.map((s) => s.platform)).toEqual(["all", "android"]);
    expect(allChecks(body).map((c) => c.id)).not.toContain("app-store-connect");
  }, SLOW);

  it("is never computed on its own — only when asked for", async () => {
    const { app, uses } = await harness();
    const cookies = { laneyard_session: await login(app) };

    // The screens a browser opens first. None of them shells out to git or bundler.
    await app.inject({ method: "GET", url: "/api/projects", cookies });
    await app.inject({ method: "GET", url: "/api/projects/sample/runs", cookies });
    await app.inject({ method: "GET", url: "/api/projects/sample/secrets", cookies });
    expect(uses).not.toHaveBeenCalled();

    await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    expect(uses).toHaveBeenCalledTimes(1);
  }, SLOW);

  it("counts a properties file Laneyard wrote as absent", async () => {
    // A run killed before cleanup can leave one behind. Counting it would turn
    // the warning into "present, so the release key is used" — a green verdict
    // Laneyard manufactured for itself.
    const { app, root } = await harness({
      files: { "app/build.gradle.kts": FLUTTER_KTS },
      uses: async () => GRADLE_USES,
    });
    const cookies = { laneyard_session: await login(app) };

    // The first request is what clones the workspace; only after it does a
    // path inside it exist to write into.
    await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    const workspacePath = join(root, "workspaces", "sample");
    await writeFile(
      join(workspacePath, "key.properties"),
      `${LANEYARD_MARKER}\nstorePassword=whatever\n`,
      "utf8",
    );

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    const signing = byId(allChecks(res.json() as Report), "release-signing");
    expect(signing.state).toBe("warn");
    expect(signing.detail).toMatch(/is not in the clone/);
  }, SLOW);

  // The field nobody fills in correctly from memory, answered from the clone so
  // the form can arrive pre-filled rather than blank.
  it("says where the build reads its properties file", async () => {
    const { app } = await harness({
      files: { "app/build.gradle.kts": FLUTTER_KTS },
      uses: async () => GRADLE_USES,
    });
    const cookies = { laneyard_session: await login(app) };

    // The clone has to exist first: this route never fetches one.
    await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/signing-hints", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ propertiesPath: "key.properties" });
  }, SLOW);

  // What happened in the field: a path a directory off, a file written where
  // nothing reads it, and an `.aab` signed with the debug key that the store
  // refused. The run still goes — the parser can be wrong too — but nobody has
  // to find out from Google.
  it("warns when the keystore block names a path the build does not read", async () => {
    const { app } = await harness({
      files: { "app/build.gradle.kts": FLUTTER_KTS },
      uses: async () => GRADLE_USES,
    });
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/android_keystore",
      cookies,
      payload: {
        fileName: "upload.jks",
        fileBase64: Buffer.from("not really a keystore").toString("base64"),
        fields: {
          key_alias: "upload",
          store_password: "a-store-password",
          key_password: "a-key-password",
          properties_path: "android/key.properties",
        },
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    const signing = byId(allChecks(res.json() as Report), "release-signing");
    expect(signing.state).toBe("warn");
    expect(signing.detail).toMatch(/debug key/);
    expect(signing.detail).toMatch(/android\/key\.properties/);
  }, SLOW);

  it("still counts an unmarked properties file as present", async () => {
    // The complement matters as much as the case above: a fix that made every
    // file invisible would pass that test while destroying this check for
    // every project that legitimately keeps its keystore properties in the
    // clone.
    const { app, root } = await harness({
      files: { "app/build.gradle.kts": FLUTTER_KTS },
      uses: async () => GRADLE_USES,
    });
    const cookies = { laneyard_session: await login(app) };

    await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    const workspacePath = join(root, "workspaces", "sample");
    await writeFile(join(workspacePath, "key.properties"), "storePassword=whatever\n", "utf8");

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    const signing = byId(allChecks(res.json() as Report), "release-signing");
    expect(signing.state).toBe("unknown");
    expect(signing.detail).toMatch(/is present/);
  }, SLOW);
});

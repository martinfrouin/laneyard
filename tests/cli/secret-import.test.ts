import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvFile, planImport } from "../../src/cli/secret-import.js";
import { tmpDir } from "../fixtures/repos.js";

describe("parseEnvFile", () => {
  it("reads names and values", () => {
    const env = parseEnvFile("ASC_KEY_ID=ABC123\nSENTRY_ORG=acme\n");
    expect(env.get("ASC_KEY_ID")).toBe("ABC123");
    expect(env.get("SENTRY_ORG")).toBe("acme");
  });

  // A value that silently kept its quotes is a credential that never works,
  // with nothing on screen to say why. Fastlane's own dotenv strips them.
  it("strips the quotes a hand-written .env often has", () => {
    expect(parseEnvFile('A="quoted"\nB=\'single\'\n').get("A")).toBe("quoted");
    expect(parseEnvFile("B='single'").get("B")).toBe("single");
  });

  it("skips comments and understands export", () => {
    const env = parseEnvFile("# a note\nexport TOKEN=abc\n");
    expect([...env.keys()]).toEqual(["TOKEN"]);
    expect(env.get("TOKEN")).toBe("abc");
  });

  it("takes the last assignment, the way dotenv would", () => {
    expect(parseEnvFile("A=first\nA=second\n").get("A")).toBe("second");
  });
});

describe("planImport", () => {
  /** A fastlane folder with a real key file beside it, as a project has. */
  async function project(): Promise<string> {
    const dir = await tmpDir("laneyard-import-");
    await mkdir(join(dir, "secrets"), { recursive: true });
    await writeFile(join(dir, "secrets", "AuthKey.p8"), "-----BEGIN PRIVATE KEY-----\n", "utf8");
    await writeFile(join(dir, "secrets", "play.json"), '{"type":"service_account"}', "utf8");
    return dir;
  }

  it("stores an ordinary variable as it is", async () => {
    const plan = await planImport(new Map([["APP_VERSION", "1.4.0"]]), await project(), []);
    expect(plan.planned).toEqual([{ key: "APP_VERSION", kind: "value", value: "1.4.0" }]);
  });

  /**
   * The translation that makes the whole command worth running. A path points
   * at a file on one laptop; copied verbatim it points at nothing on the build
   * machine, and the run fails exactly as it did before the import.
   */
  it("stores the contents of a .p8, under the name fastlane looks for", async () => {
    const dir = await project();
    const plan = await planImport(new Map([["ASC_KEY_FILEPATH", "secrets/AuthKey.p8"]]), dir, []);

    expect(plan.planned).toHaveLength(1);
    expect(plan.planned[0]).toMatchObject({
      key: "APP_STORE_CONNECT_API_KEY_P8",
      from: "ASC_KEY_FILEPATH",
      kind: "file-contents",
    });
    expect(plan.planned[0]!.value).toContain("BEGIN PRIVATE KEY");
  });

  it("does the same for a Play Store service account", async () => {
    const dir = await project();
    const plan = await planImport(new Map([["SUPPLY_JSON_KEY", "secrets/play.json"]]), dir, []);

    expect(plan.planned[0]).toMatchObject({
      key: "SUPPLY_JSON_KEY_DATA",
      kind: "file-contents",
    });
    expect(plan.planned[0]!.value).toContain("service_account");
  });

  it("takes an absolute path as readily as a relative one", async () => {
    const dir = await project();
    const plan = await planImport(
      new Map([["ASC_KEY_FILEPATH", join(dir, "secrets", "AuthKey.p8")]]),
      "/somewhere/else",
      [],
    );
    expect(plan.planned[0]!.kind).toBe("file-contents");
  });

  // Reported rather than skipped in silence: it is the credential the project
  // most needs, and saying nothing would read as success.
  it("reports a path that is not there instead of passing over it", async () => {
    const plan = await planImport(new Map([["ASC_KEY_FILEPATH", "secrets/gone.p8"]]), await project(), []);

    expect(plan.planned[0]).toMatchObject({ key: "ASC_KEY_FILEPATH", kind: "unresolved-path" });
    expect(plan.replacing).toEqual([]);
  });

  it("says which names it would replace, under the name it would store", async () => {
    const dir = await project();
    const plan = await planImport(
      new Map([
        ["APP_VERSION", "1.4.0"],
        ["ASC_KEY_FILEPATH", "secrets/AuthKey.p8"],
      ]),
      dir,
      ["APP_VERSION", "APP_STORE_CONNECT_API_KEY_P8"],
    );
    expect(plan.replacing.sort()).toEqual(["APP_STORE_CONNECT_API_KEY_P8", "APP_VERSION"]);
  });

  it("passes over a variable with no value rather than storing an empty secret", async () => {
    const plan = await planImport(new Map([["EMPTY", ""]]), await project(), []);
    expect(plan.planned).toEqual([]);
  });
});

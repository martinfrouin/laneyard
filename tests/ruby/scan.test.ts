import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../fixtures/repos.js";

const exec = promisify(execFile);
const SCRIPT = join(process.cwd(), "ruby", "scan.rb");

async function projectWithFastfile(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-scan-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  await writeFile(join(dir, "fastlane", "Fastfile"), content, "utf8");
  return dir;
}

/** No fastlane environment: that is the point of this script. */
async function scan(dir: string): Promise<any> {
  const { stdout } = await exec("ruby", [SCRIPT, "--fastlane-dir", "fastlane"], {
    cwd: dir,
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

describe("scan.rb", () => {
  it("reports a literal keyword argument with byte ranges", async () => {
    const source = `lane :beta do\n  app_store_connect_api_key(key_filepath: "./AuthKey_9K2LM4XY.p8")\nend\n`;
    const dir = await projectWithFastfile(source);

    const res = await scan(dir);
    expect(res.ok).toBe(true);
    expect(res.literals).toHaveLength(1);

    const [found] = res.literals;
    expect(found.action).toBe("app_store_connect_api_key");
    expect(found.arg).toBe("key_filepath");
    expect(found.value).toBe("./AuthKey_9K2LM4XY.p8");

    // The value range covers the literal including its quotes.
    expect(source.slice(found.value_start, found.value_start + found.value_length))
      .toBe('"./AuthKey_9K2LM4XY.p8"');
    // The pair range covers `key: value`.
    expect(source.slice(found.pair_start, found.pair_start + found.pair_length))
      .toBe('key_filepath: "./AuthKey_9K2LM4XY.p8"');
  });

  it("ignores a keyword whose value is not a literal string", async () => {
    const dir = await projectWithFastfile(
      `lane :beta do\n  supply(json_key: ENV.fetch("SUPPLY_JSON_KEY"))\nend\n`,
    );
    expect((await scan(dir)).literals).toEqual([]);
  });

  it("ignores text inside a comment", async () => {
    const dir = await projectWithFastfile(
      `lane :beta do\n  # supply(json_key: "./play.json")\n  build_app\nend\n`,
    );
    expect((await scan(dir)).literals).toEqual([]);
  });

  it("reports a Fastfile that does not parse as an error, not a crash", async () => {
    const dir = await projectWithFastfile(`lane :beta do\n  build_app(\nend\n`);
    const res = await scan(dir);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not be parsed/i);
  });

  it("finds literals in a method the Fastfile defines, not only in lanes", async () => {
    const dir = await projectWithFastfile(
      `def ship\n  supply(json_key: "./play.json")\nend\nlane :beta do\n  ship\nend\n`,
    );
    const res = await scan(dir);
    expect(res.literals.map((l: any) => l.arg)).toEqual(["json_key"]);
  });
});

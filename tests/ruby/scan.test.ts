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

/**
 * Both streams, and never a throw: what this script writes where is half of
 * its contract, and a test that only sees stdout cannot check the other half.
 *
 * No fastlane environment either: that is the point of this script.
 */
async function run(dir: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec("ruby", [SCRIPT, "--fastlane-dir", "fastlane"], {
      cwd: dir,
      timeout: 30_000,
    });
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function scan(dir: string): Promise<any> {
  return JSON.parse((await run(dir)).stdout);
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

  it("reports offsets in bytes, not in characters", async () => {
    // The caller splices these ranges into a Buffer. An accented comment above
    // the literal is all it takes for character offsets to land the patch in
    // the middle of a string, so the fixture puts several of them there and the
    // assertions slice bytes — a JavaScript `slice` over ASCII proves nothing.
    const source =
      `lane :beta do\n  # clé privée de déploiement à Cupertino — accès restreint\n  app_store_connect_api_key(key_filepath: "./AuthKey_9K2LM4XY.p8")\nend\n`;
    const dir = await projectWithFastfile(source);

    const res = await scan(dir);
    const [found] = res.literals;
    const bytes = Buffer.from(source, "utf8");

    expect(bytes.subarray(found.value_start, found.value_start + found.value_length).toString())
      .toBe('"./AuthKey_9K2LM4XY.p8"');
    expect(bytes.subarray(found.pair_start, found.pair_start + found.pair_length).toString())
      .toBe('key_filepath: "./AuthKey_9K2LM4XY.p8"');

    // And the same range read as characters must *not* line up, which is what
    // makes the two assertions above a test of the byte contract rather than a
    // restatement of the first test in this file.
    expect(source.slice(found.value_start, found.value_start + found.value_length))
      .not.toBe('"./AuthKey_9K2LM4XY.p8"');
  });

  it("reports a keyword argument written inside braces", async () => {
    // `supply({json_key: "..."})` is a HashNode, not a KeywordHashNode, and is
    // as much a keyword argument as the braceless form.
    const source = `lane :beta do\n  supply({json_key: "./brace.json"})\nend\n`;
    const dir = await projectWithFastfile(source);

    const res = await scan(dir);
    expect(res.literals).toHaveLength(1);

    const [found] = res.literals;
    expect(found.action).toBe("supply");
    expect(found.arg).toBe("json_key");
    expect(source.slice(found.pair_start, found.pair_start + found.pair_length))
      .toBe('json_key: "./brace.json"');
  });

  it("does not descend into a nested hash", async () => {
    // The inner key is a bundle id, not a keyword, so there is nothing the
    // caller could rewrite: reporting it under `gym` would be noise.
    const dir = await projectWithFastfile(
      `lane :beta do\n  gym(export_options: { provisioningProfiles: { "com.x.y" => "./x.mobileprovision" } })\nend\n`,
    );
    expect((await scan(dir)).literals).toEqual([]);
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

  it("ignores a heredoc value, whose range would delimit the marker", async () => {
    // `<<~P` is four bytes; the string it stands for lives on the lines below.
    // Splicing the reported range would leave the heredoc body stranded after
    // the call and produce a Fastfile that no longer parses.
    const dir = await projectWithFastfile(
      `lane :beta do\n  sigh(api_key_path: <<~P)\n    ./AuthKey_HEREDOC.p8\n  P\nend\n`,
    );
    expect((await scan(dir)).literals).toEqual([]);
  });

  it("reports a Fastfile that does not parse as an error, not a crash", async () => {
    const dir = await projectWithFastfile(`lane :beta do\n  build_app(\nend\n`);
    const res = await scan(dir);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not be parsed/i);
  });

  it("answers a structured error when a literal is not valid UTF-8", async () => {
    // Serialising this literal raises inside Ruby. The contract says an error
    // is a valid response; a trace on stderr and an empty stdout is not one.
    const dir = await projectWithFastfile(
      `lane :beta do\n  supply(json_key: "./key\\xFF.json")\nend\n`,
    );
    const { stdout, stderr } = await run(dir);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).ok).toBe(false);
  });

  it("finds literals in a method the Fastfile defines, not only in lanes", async () => {
    const dir = await projectWithFastfile(
      `def ship\n  supply(json_key: "./play.json")\nend\nlane :beta do\n  ship\nend\n`,
    );
    const res = await scan(dir);
    expect(res.literals.map((l: any) => l.arg)).toEqual(["json_key"]);
  });
});

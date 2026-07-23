import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanFastfile } from "../../src/sidecar/scan.js";
import { tmpDir } from "../fixtures/repos.js";

async function projectWithFastfile(content: string): Promise<string> {
  const dir = await tmpDir("laneyard-scanner-");
  await mkdir(join(dir, "fastlane"), { recursive: true });
  await writeFile(join(dir, "fastlane", "Fastfile"), content, "utf8");
  return dir;
}

describe("scanFastfile", () => {
  it("returns the literals a Fastfile holds", async () => {
    const dir = await projectWithFastfile(
      `lane :beta do\n  supply(json_key: "./play.json")\nend\n`,
    );
    const found = await scanFastfile(dir, "fastlane");
    expect(found?.map((l) => l.arg)).toEqual(["json_key"]);
  });

  it("answers null for a Fastfile that does not parse, rather than throwing", async () => {
    const dir = await projectWithFastfile(`lane :beta do\n  build_app(\nend\n`);
    await expect(scanFastfile(dir, "fastlane")).resolves.toBeNull();
  });

  it("answers null when the directory holds no Fastfile", async () => {
    const dir = await tmpDir("laneyard-scanner-");
    await expect(scanFastfile(dir, "fastlane")).resolves.toBeNull();
  });

  // Prism counts bytes; JavaScript strings count UTF-16 code units. A comment
  // with an accented character sitting above the call shifts every later byte
  // offset away from the string-index offset that a naive `slice` would use —
  // this is the trap that matters most in this module's contract, and the
  // whole point of carrying `valueStart`/`valueLength` as bytes rather than
  // re-deriving them by re-parsing the string in JavaScript.
  it("reports byte offsets that survive a multi-byte character earlier in the file", async () => {
    const content = `# Clé API déjà présente\nlane :beta do\n  supply(json_key: "./play.json")\nend\n`;
    const dir = await projectWithFastfile(content);
    const found = await scanFastfile(dir, "fastlane");
    expect(found).not.toBeNull();
    const literal = found![0]!;

    const buffer = Buffer.from(content, "utf8");
    const sliced = buffer
      .subarray(literal.valueStart, literal.valueStart + literal.valueLength)
      .toString("utf8");
    expect(sliced).toBe('"./play.json"');

    const pairSliced = buffer
      .subarray(literal.pairStart, literal.pairStart + literal.pairLength)
      .toString("utf8");
    expect(pairSliced).toBe('json_key: "./play.json"');
  });
});

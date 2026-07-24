import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertFastlaneDir } from "../../src/sidecar/fastlane-dir.js";
import { tmpDir } from "../fixtures/repos.js";

/** The refusal, or "" when it accepted. */
async function refusal(workspace: string, configured: string): Promise<string> {
  try {
    await assertFastlaneDir(workspace, configured);
    return "";
  } catch (cause) {
    return (cause as Error).message;
  }
}

describe("assertFastlaneDir", () => {
  it("accepts a fastlane folder that is there", async () => {
    const workspace = await tmpDir("fd-");
    await mkdir(join(workspace, "app", "fastlane"), { recursive: true });

    expect(await refusal(workspace, "app/fastlane")).toBe("");
  });

  it("says the project has not been cloned when there is no workspace at all", async () => {
    // The git advice is wrong for this one: nobody failed to push anything, the
    // repository has simply never been fetched. Blaming git sent people hunting
    // for a problem that did not exist.
    const workspace = join(await tmpDir("fd-"), "never-cloned");

    const said = await refusal(workspace, "app/fastlane");
    expect(said).toMatch(/not been cloned/i);
    expect(said).not.toMatch(/gitignored/);
  });

  it("blames the missing folder when the clone is there without it", async () => {
    const workspace = await tmpDir("fd-");

    const said = await refusal(workspace, "app/fastlane");
    expect(said).toContain("app/fastlane");
    expect(said).toMatch(/gitignored/);
  });
});

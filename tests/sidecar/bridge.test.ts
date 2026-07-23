import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSidecarScript } from "../../src/sidecar/bridge.js";
import { tmpDir } from "../fixtures/repos.js";

/** Builds a package layout with the sidecar script where the package ships it. */
async function packageAt(...files: string[]): Promise<string> {
  const root = await tmpDir("laneyard-pkg-");
  await mkdir(join(root, "ruby"), { recursive: true });
  for (const file of files.length ? files : ["introspect.rb"]) {
    await writeFile(join(root, "ruby", file), "# sidecar\n", "utf8");
  }
  return root;
}

describe("resolveSidecarScript", () => {
  it("finds the script when running from the sources", async () => {
    const root = await packageAt();
    expect(resolveSidecarScript(join(root, "src", "sidecar"))).toBe(
      join(root, "ruby", "introspect.rb"),
    );
  });

  it("finds the script when running from the build", async () => {
    // This is the layout every installed copy uses, and the one that was broken:
    // listing lanes failed with "No such file or directory" on `dist/ruby`,
    // while the sources worked perfectly and hid it.
    const root = await packageAt();
    expect(resolveSidecarScript(join(root, "dist", "src", "sidecar"))).toBe(
      join(root, "ruby", "introspect.rb"),
    );
  });

  it("still returns a path when the script is missing, so the error names it", async () => {
    const root = await tmpDir("laneyard-pkg-");
    expect(resolveSidecarScript(join(root, "src", "sidecar"))).toContain("introspect.rb");
  });

  it("resolves a named sidecar script in both layouts", async () => {
    // Both, and against a built layout rather than this repo: naming a second
    // script is exactly where the two-levels/three-levels bug would come back,
    // and asserting against `process.cwd()` tested the sources twice over —
    // the half that shipped broken in every installed copy is the other one.
    const root = await packageAt("scan.rb");
    expect(resolveSidecarScript(join(root, "src", "sidecar"), "scan.rb")).toBe(
      join(root, "ruby", "scan.rb"),
    );
    expect(resolveSidecarScript(join(root, "dist", "src", "sidecar"), "scan.rb")).toBe(
      join(root, "ruby", "scan.rb"),
    );
  });

  it("still defaults to introspect.rb", async () => {
    // With both scripts on disk, so the default is shown to be a choice.
    const root = await packageAt("introspect.rb", "scan.rb");
    expect(resolveSidecarScript(join(root, "src", "sidecar"))).toBe(
      join(root, "ruby", "introspect.rb"),
    );
  });
});

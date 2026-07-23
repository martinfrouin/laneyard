import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSidecarScript } from "../../src/sidecar/bridge.js";
import { tmpDir } from "../fixtures/repos.js";

/** Builds a package layout with the sidecar script where the package ships it. */
async function packageAt(): Promise<string> {
  const root = await tmpDir("laneyard-pkg-");
  await mkdir(join(root, "ruby"), { recursive: true });
  await writeFile(join(root, "ruby", "introspect.rb"), "# sidecar\n", "utf8");
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

  it("resolves a named sidecar script in both layouts", () => {
    // `src/sidecar/` sits two levels under the package root.
    const fromSource = resolveSidecarScript(join(process.cwd(), "src", "sidecar"), "scan.rb");
    expect(fromSource).toBe(join(process.cwd(), "ruby", "scan.rb"));
  });

  it("still defaults to introspect.rb", () => {
    const path = resolveSidecarScript(join(process.cwd(), "src", "sidecar"));
    expect(path.endsWith(join("ruby", "introspect.rb"))).toBe(true);
  });
});

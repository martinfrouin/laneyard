import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectHere } from "../../src/main.js";
import { tmpDir } from "../fixtures/repos.js";

/**
 * Which project the address printed at startup should open.
 *
 * Someone running `laneyard` from `popotheque/app` is not asking to be shown a
 * menu of everything they have ever built. The terminal is the one place that
 * knows which project they mean, and `laneyard.yml` is where the slug is.
 */
describe("projectHere", () => {
  const withYml = async (dir: string, body: string): Promise<string> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "laneyard.yml"), body);
    return dir;
  };

  it("finds the project of the directory it was started from", async () => {
    const root = await tmpDir("laneyard-here-");
    await withYml(root, "slug: popotheque\nfastlane_dir: fastlane\n");
    expect(await projectHere(root, ["popotheque"])).toBe("popotheque");
  });

  it("walks up, so a subdirectory of the app still finds it", async () => {
    const root = await tmpDir("laneyard-here-");
    await withYml(join(root, "app"), "slug: popotheque\n");
    const deep = join(root, "app", "lib", "screens");
    await mkdir(deep, { recursive: true });
    expect(await projectHere(deep, ["popotheque"])).toBe("popotheque");
  });

  it("takes the innermost file, which is the app rather than the monorepo", async () => {
    const root = await tmpDir("laneyard-here-");
    await withYml(root, "slug: monorepo\n");
    const app = await withYml(join(root, "app"), "slug: popotheque\n");
    expect(await projectHere(app, ["monorepo", "popotheque"])).toBe("popotheque");
  });

  /**
   * A slug no longer in `config.yml` names a project the server does not have,
   * and an address pointing at it would open the unknown-page line. The plain
   * address is the honest fallback.
   */
  it("answers null for a slug the server does not know", async () => {
    const root = await tmpDir("laneyard-here-");
    await withYml(root, "slug: removed-last-week\n");
    expect(await projectHere(root, ["popotheque"])).toBeNull();
  });

  it("answers null with no file, an unreadable one, or one with no slug", async () => {
    expect(await projectHere(await tmpDir("laneyard-here-"), ["popotheque"])).toBeNull();

    const broken = await withYml(await tmpDir("laneyard-here-"), "slug: [unclosed\n");
    expect(await projectHere(broken, ["popotheque"])).toBeNull();

    const anonymous = await withYml(await tmpDir("laneyard-here-"), "fastlane_dir: fastlane\n");
    expect(await projectHere(anonymous, ["popotheque"])).toBeNull();
  });
});

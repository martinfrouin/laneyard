import { describe, expect, it } from "vitest";
import { projectSettingsInputSchema } from "../../src/config/schema.js";

describe("projectSettingsSchema", () => {
  it("carries a slug written in a laneyard.yml", () => {
    const parsed = projectSettingsInputSchema.parse({ slug: "my-app", runtime: "bundle" });
    expect(parsed.slug).toBe("my-app");
  });

  it("still parses a laneyard.yml with no slug, for older files", () => {
    const parsed = projectSettingsInputSchema.parse({ runtime: "bundle" });
    expect(parsed.slug).toBeUndefined();
  });

  it("rejects a slug that is not a valid slug", () => {
    expect(() => projectSettingsInputSchema.parse({ slug: "Not A Slug" })).toThrow();
  });

  it("takes an env_file inside the app, and refuses one that leaves it", () => {
    // The file is written into a clone Laneyard owns. A path climbing out of it
    // would let a configuration drop a file of secrets anywhere on the server,
    // so it is refused at load — the last moment before anything acts on it.
    expect(projectSettingsInputSchema.parse({ env_file: ".env" }).env_file).toBe(".env");
    expect(projectSettingsInputSchema.parse({ env_file: "ios/Config.xcconfig" }).env_file).toBe(
      "ios/Config.xcconfig",
    );

    for (const bad of ["../.env", "../../etc/passwd", "/etc/passwd", "a/../../b/.env", ""]) {
      expect(() => projectSettingsInputSchema.parse({ env_file: bad })).toThrow();
    }
  });
});

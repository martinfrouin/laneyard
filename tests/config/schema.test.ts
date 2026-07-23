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
});

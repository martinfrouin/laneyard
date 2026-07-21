import { describe, expect, it } from "vitest";
import { version } from "../src/main.js";

describe("laneyard", () => {
  it("exposes its version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

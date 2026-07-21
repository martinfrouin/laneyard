import { describe, expect, it } from "vitest";
import { version } from "../src/main.js";

describe("laneyard", () => {
  it("expose sa version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

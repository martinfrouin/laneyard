import { describe, expect, it } from "vitest";
import { LiveStepTracker } from "../../src/runner/live-steps.js";

describe("LiveStepTracker", () => {
  it("spots a step and keeps its offset", () => {
    const t = new LiveStepTracker();
    t.consume("[09:41:02]: noise before\n", 0);
    t.consume("[09:41:03]: ------ Step: build_app ------\n", 30);
    expect(t.steps()).toEqual([{ name: "build_app", logOffset: 30 }]);
  });

  it("spots several steps in order of appearance", () => {
    const t = new LiveStepTracker();
    t.consume("[t]: --- Step: match ---\n[t]: --- Step: build_app ---\n", 100);
    expect(t.steps().map((s) => s.name)).toEqual(["match", "build_app"]);
    expect(t.steps()[0]!.logOffset).toBe(100);
    expect(t.steps()[1]!.logOffset).toBeGreaterThan(100);
  });

  it("rejoins a line split across two fragments", () => {
    const t = new LiveStepTracker();
    t.consume("[t]: ------ Step: buil", 0);
    t.consume("d_app ------\n", 17);
    expect(t.steps().map((s) => s.name)).toEqual(["build_app"]);
  });

  it("spots a real fastlane separator, ANSI colors included", () => {
    const t = new LiveStepTracker();
    // Line copied from a real run: the name of a `sh` action is the
    // entire command, spaces included.
    t.consume(
      "[13:14:00]: [32m--- Step: mkdir -p ../build && echo x > y.ipa ---[0m\r\n",
      0,
    );
    expect(t.steps().map((s) => s.name)).toEqual(["mkdir -p ../build && echo x > y.ipa"]);
  });

  it("ignores a line that mentions Step without being a separator", () => {
    const t = new LiveStepTracker();
    t.consume("The word Step: appears here with no dashes\n", 0);
    expect(t.steps()).toEqual([]);
  });
});

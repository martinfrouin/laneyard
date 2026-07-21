import { describe, expect, it } from "vitest";
import { LiveStepTracker } from "../../src/runner/live-steps.js";

describe("LiveStepTracker", () => {
  it("repère une étape et retient son décalage", () => {
    const t = new LiveStepTracker();
    t.consume("[09:41:02]: bruit avant\n", 0);
    t.consume("[09:41:03]: ------ Step: build_app ------\n", 30);
    expect(t.steps()).toEqual([{ name: "build_app", logOffset: 30 }]);
  });

  it("repère plusieurs étapes dans l'ordre d'apparition", () => {
    const t = new LiveStepTracker();
    t.consume("[t]: --- Step: match ---\n[t]: --- Step: build_app ---\n", 100);
    expect(t.steps().map((s) => s.name)).toEqual(["match", "build_app"]);
    expect(t.steps()[0]!.logOffset).toBe(100);
    expect(t.steps()[1]!.logOffset).toBeGreaterThan(100);
  });

  it("recolle une ligne coupée entre deux fragments", () => {
    const t = new LiveStepTracker();
    t.consume("[t]: ------ Step: buil", 0);
    t.consume("d_app ------\n", 17);
    expect(t.steps().map((s) => s.name)).toEqual(["build_app"]);
  });

  it("ignore une ligne qui mentionne Step sans être un séparateur", () => {
    const t = new LiveStepTracker();
    t.consume("Le mot Step: apparaît ici sans tirets\n", 0);
    expect(t.steps()).toEqual([]);
  });
});

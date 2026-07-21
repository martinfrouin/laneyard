import { describe, expect, it } from "vitest";
import { BLOCKING_RULES, findBlockingActions } from "../../src/heuristics/blocking-actions.js";

describe("findBlockingActions", () => {
  it("reports an action that always blocks", () => {
    const findings = findBlockingActions([{ name: "prompt", args: {} }]);
    expect(findings.map((f) => f.action)).toEqual(["prompt"]);
  });

  it("reports a conditionally-blocking action only when the matching literal is passed", () => {
    const findings = findBlockingActions([{ name: "match", args: { readonly: false } }]);
    expect(findings.map((f) => f.action)).toEqual(["match"]);
    expect(findings[0]!.because).toMatch(/Apple account/);
  });

  it("does not report the same action when the literal argument doesn't match", () => {
    const findings = findBlockingActions([{ name: "match", args: { readonly: true } }]);
    expect(findings).toEqual([]);
  });

  it("does not report a lane that passed the argument non-literally", () => {
    // The sidecar reports no literal for `readonly: ENV["RO"]`: the args hash
    // simply doesn't have the key. Reporting a guess here would be dishonest.
    const findings = findBlockingActions([{ name: "match", args: {} }]);
    expect(findings).toEqual([]);
  });

  it("never reports an action the table doesn't know about", () => {
    const findings = findBlockingActions([{ name: "some_custom_action", args: {} }]);
    expect(findings).toEqual([]);
  });

  it("is driven entirely by the BLOCKING_RULES table", () => {
    expect(Array.isArray(BLOCKING_RULES)).toBe(true);
    expect(BLOCKING_RULES.find((r) => r.action === "sigh")).toBeDefined();
  });
});

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

  it("reports cert, which asks for an Apple account", () => {
    const findings = findBlockingActions([{ name: "cert", args: {} }]);
    expect(findings.map((f) => f.action)).toEqual(["cert"]);
    expect(findings[0]!.fix).toMatch(/match/);
  });

  it("reports an upload that waits for its summary to be confirmed", () => {
    // `deliver` renders an HTML preview and waits for a yes unless `force` says
    // otherwise. A lane that passes `force: false` explicitly means it.
    const findings = findBlockingActions([{ name: "upload_to_app_store", args: { force: false } }]);
    expect(findings.map((f) => f.action)).toEqual(["upload_to_app_store"]);
    expect(findings[0]!.fix).toMatch(/force: true/);
  });

  it("says nothing about an upload that already passes force: true", () => {
    expect(findBlockingActions([{ name: "deliver", args: { force: true } }])).toEqual([]);
  });
});

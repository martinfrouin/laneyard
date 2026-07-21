import { describe, expect, it } from "vitest";
import { summarizeFailure } from "../../src/heuristics/error-summary.js";

/** Output tail observed on a real failed run, ANSI sequences included. */
const REAL_TAIL = [
  "[13:19:32]: [31mCalled from Fastfile at line 7[0m",
  '[13:19:32]:  => 7:\t  UI.user_error!("code signature rejected by the keychain")',
  "[13:19:32]: [31mfastlane finished with errors[0m",
  "[31m[!] code signature rejected by the keychain[0m",
].join("\n");

describe("summarizeFailure", () => {
  it("keeps the cause marked by fastlane, without ANSI or marker", () => {
    expect(summarizeFailure(REAL_TAIL, 1)).toBe("code signature rejected by the keychain");
  });

  it("discards the generic closing message, which teaches nothing", () => {
    const log = "[13:19:32]: Compiling\n[13:19:32]: fastlane finished with errors";
    expect(summarizeFailure(log, 1)).not.toMatch(/finished with errors/);
  });

  it("falls back to a line mentioning an error when the marker is missing", () => {
    const log = "[10:00:00]: Compiling\n[10:00:01]: error: no signing certificate found\n[10:00:02]: bye";
    expect(summarizeFailure(log, 65)).toBe("error: no signing certificate found");
  });

  it("falls back to the exit code when the output teaches nothing", () => {
    expect(summarizeFailure("[10:00:00]: all good", 65)).toBe(
      "fastlane stopped with exit code 65",
    );
  });

  it("stays readable when the run produced no output", () => {
    expect(summarizeFailure("", null)).toBe("The run failed with no usable message");
  });

  it("truncates an oversized cause rather than flooding the list", () => {
    expect(summarizeFailure(`[!] ${"x".repeat(900)}`, 1)).toHaveLength(500);
  });
});

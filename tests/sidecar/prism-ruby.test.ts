import { describe, expect, it } from "vitest";
import { resolvePrismRuby } from "../../src/sidecar/prism-ruby.js";

describe("resolvePrismRuby", () => {
  it("finds a Ruby that can require prism, or answers null", async () => {
    const env = await resolvePrismRuby();
    // Either answer is correct — what must never happen is a throw.
    expect(env === null || typeof env === "object").toBe(true);
  });

  it("memoizes, so setup pays the probe once", async () => {
    const a = resolvePrismRuby();
    const b = resolvePrismRuby();
    expect(a).toBe(b);
  });
});

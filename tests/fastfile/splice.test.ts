import { describe, expect, it } from "vitest";
import { splice } from "../../src/fastfile/splice.js";

describe("splice", () => {
  it("replaces one range and leaves every other byte alone", () => {
    const source = `lane :beta do\n  supply(json_key: "./play.json")\nend\n`;
    const start = source.indexOf('"./play.json"');
    const out = splice(source, [
      { start, length: '"./play.json"'.length, replacement: 'ENV.fetch("SUPPLY_JSON_KEY")' },
    ]);
    expect(out).toBe(`lane :beta do\n  supply(json_key: ENV.fetch("SUPPLY_JSON_KEY"))\nend\n`);
  });

  it("applies several edits without letting earlier ones shift later ones", () => {
    const source = `a("one")\nb("two")\n`;
    const out = splice(source, [
      { start: source.indexOf('"one"'), length: 5, replacement: "X" },
      { start: source.indexOf('"two"'), length: 5, replacement: "YYYYYYYY" },
    ]);
    expect(out).toBe(`a(X)\nb(YYYYYYYY)\n`);
  });

  it("accepts edits in any order", () => {
    const source = `a("one")\nb("two")\n`;
    const forward = splice(source, [
      { start: source.indexOf('"one"'), length: 5, replacement: "X" },
      { start: source.indexOf('"two"'), length: 5, replacement: "Y" },
    ]);
    const reversed = splice(source, [
      { start: source.indexOf('"two"'), length: 5, replacement: "Y" },
      { start: source.indexOf('"one"'), length: 5, replacement: "X" },
    ]);
    expect(forward).toBe(reversed);
  });

  it("refuses overlapping edits rather than producing nonsense", () => {
    const source = `a("one")\n`;
    expect(() =>
      splice(source, [
        { start: 2, length: 5, replacement: "X" },
        { start: 4, length: 3, replacement: "Y" },
      ]),
    ).toThrow(/overlap/i);
  });

  it("returns the source untouched when there is nothing to do", () => {
    const source = `lane :beta do\nend\n`;
    expect(splice(source, [])).toBe(source);
  });

  it("counts in bytes, so a literal after an accented comment still lands right", () => {
    const source = `# déjà là\nsupply(json_key: "./play.json")\n`;
    const buf = Buffer.from(source, "utf8");
    const start = buf.indexOf(Buffer.from('"./play.json"', "utf8"));
    const out = splice(source, [{ start, length: 13, replacement: "X" }]);
    expect(out).toBe(`# déjà là\nsupply(json_key: X)\n`);
  });
});

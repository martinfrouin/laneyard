import { describe, expect, it } from "vitest";
import { NO_APPFILE, parseAppfile } from "../../src/heuristics/appfile.js";

describe("parseAppfile", () => {
  it("reads a bare literal", () => {
    const facts = parseAppfile('json_key_file "fastlane/play.json"\n');
    expect(facts.jsonKeyFile).toEqual({ kind: "literal", value: "fastlane/play.json" });
  });

  it("reads the parenthesised form, and single quotes", () => {
    expect(parseAppfile("json_key_file('play.json')").jsonKeyFile).toEqual({
      kind: "literal",
      value: "play.json",
    });
  });

  it("reads a key set inside a for_platform block", () => {
    const facts = parseAppfile(`
for_platform :android do
  json_key_file "keys/play.json"
  package_name "com.example"
end
`);
    expect(facts.jsonKeyFile).toEqual({ kind: "literal", value: "keys/play.json" });
  });

  // The whole reason the value is a union rather than a string: a computed
  // value is set, and a check that reported "absent" for it would be wrong in
  // the one direction that matters.
  it("calls a computed value computed rather than guessing at it", () => {
    expect(parseAppfile('json_key_file ENV["PLAY_KEY"]').jsonKeyFile).toEqual({ kind: "computed" });
    expect(parseAppfile("json_key_file File.expand_path(\"k.json\")").jsonKeyFile).toEqual({
      kind: "computed",
    });
  });

  it("ignores a commented-out setting", () => {
    const facts = parseAppfile('# json_key_file "old.json"\napple_id "me@example.com"\n');
    expect(facts.jsonKeyFile).toEqual({ kind: "absent" });
    expect(facts.appleId).toEqual({ kind: "literal", value: "me@example.com" });
  });

  it("takes the last assignment, the way running the file would", () => {
    const facts = parseAppfile('json_key_file "first.json"\njson_key_file "second.json"\n');
    expect(facts.jsonKeyFile).toEqual({ kind: "literal", value: "second.json" });
  });

  it("does not mistake a longer name for the one it wants", () => {
    expect(parseAppfile('json_key_file_path "x"').jsonKeyFile).toEqual({ kind: "absent" });
  });

  it("reads an empty file as nothing set", () => {
    expect(parseAppfile("")).toEqual(NO_APPFILE);
  });
});

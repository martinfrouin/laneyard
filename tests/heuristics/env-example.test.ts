import { describe, expect, it } from "vitest";
import { parseEnvExample } from "../../src/heuristics/env-example.js";

describe("parseEnvExample", () => {
  it("takes the names and never the values", () => {
    expect(parseEnvExample("ASC_KEY_ID=ABC123\nSENTRY_ORG=acme\n")).toEqual([
      "ASC_KEY_ID",
      "SENTRY_ORG",
    ]);
  });

  it("skips comments and blank lines", () => {
    const text = `# Copy this to fastlane/.env

# App Store Connect
ASC_KEY_ID=

SUPPLY_JSON_KEY=path/to.json
`;
    expect(parseEnvExample(text)).toEqual(["ASC_KEY_ID", "SUPPLY_JSON_KEY"]);
  });

  it("understands the export form", () => {
    expect(parseEnvExample("export MATCH_PASSWORD=hunter2")).toEqual(["MATCH_PASSWORD"]);
  });

  it("ignores a line it does not understand rather than inventing a requirement", () => {
    expect(parseEnvExample("this is prose\n=novalue\nOK_ONE=1\n")).toEqual(["OK_ONE"]);
  });

  it("reports a name once however often it appears", () => {
    expect(parseEnvExample("A=1\nA=2\n")).toEqual(["A"]);
  });

  it("reads an empty file as nothing required", () => {
    expect(parseEnvExample("")).toEqual([]);
  });
});

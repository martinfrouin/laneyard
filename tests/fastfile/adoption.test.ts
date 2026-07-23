import { describe, expect, it } from "vitest";
import { proposalsFor } from "../../src/fastfile/adoption.js";
import type { Literal } from "../../src/sidecar/scan.js";

const literal = (over: Partial<Literal>): Literal => ({
  action: "supply",
  arg: "json_key",
  kind: "literal",
  value: "./play.json",
  valueStart: 10,
  valueLength: 13,
  pairStart: 0,
  pairLength: 23,
  line: 2,
  ...over,
});

describe("proposalsFor", () => {
  it("proposes a path swap for a play service account, checked by default", () => {
    const [p] = proposalsFor([literal({})]);
    expect(p!.tier).toBe("file");
    expect(p!.kind).toBe("play_service_account");
    expect(p!.checked).toBe(true);
    expect(p!.edits).toEqual([{ start: 10, length: 13, replacement: 'ENV.fetch("SUPPLY_JSON_KEY")' }]);
  });

  it("uses the App Store Connect filepath name for a .p8", () => {
    const [p] = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_filepath", value: "./AuthKey_9K2LM4XY.p8" }),
    ]);
    expect(p!.kind).toBe("apple_asc");
    expect(p!.edits[0]!.replacement).toBe('ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")');
  });

  it("reads the Key ID out of the conventional filename", () => {
    const [p] = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_filepath", value: "keys/AuthKey_9K2LM4XY.p8" }),
    ]);
    expect(p!.suggestedFields).toEqual({ key_id: "9K2LM4XY" });
  });

  it("rewrites the whole pair for inline contents, not just the value", () => {
    const [p] = proposalsFor([
      literal({
        action: "app_store_connect_api_key",
        arg: "key_content",
        value: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        pairStart: 4,
        pairLength: 70,
      }),
    ]);
    expect(p!.tier).toBe("inline");
    expect(p!.edits[0]!.start).toBe(4);
    expect(p!.edits[0]!.length).toBe(70);
    expect(p!.edits[0]!.replacement).toBe('key_filepath: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")');
  });

  it("rewrites key_id and issuer_id when the key file of the same call is adopted", () => {
    const props = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_filepath", value: "./AuthKey_9K2LM4XY.p8" }),
      literal({ action: "app_store_connect_api_key", arg: "key_id", value: "9K2LM4XY", valueStart: 40, valueLength: 10 }),
      literal({ action: "app_store_connect_api_key", arg: "issuer_id", value: "6f8e-issuer", valueStart: 60, valueLength: 13 }),
    ]);
    expect(props).toHaveLength(1);
    const [p] = props;
    expect(p!.kind).toBe("apple_asc");
    expect(p!.edits).toContainEqual({
      start: 40,
      length: 10,
      replacement: 'ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_ID")',
    });
    expect(p!.edits).toContainEqual({
      start: 60,
      length: 13,
      replacement: 'ENV.fetch("APP_STORE_CONNECT_API_KEY_ISSUER_ID")',
    });
    expect(p!.suggestedFields).toEqual({ key_id: "9K2LM4XY", issuer_id: "6f8e-issuer" });
  });

  it("leaves key_id alone when no key file of the same call is adopted", () => {
    const props = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_id", value: "9K2LM4XY" }),
    ]);
    expect(props).toEqual([]);
  });

  it("prefers an explicit key_id literal over the one read from the filename", () => {
    const [p] = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_filepath", value: "./AuthKey_FROMNAME.p8" }),
      literal({ action: "app_store_connect_api_key", arg: "key_id", value: "EXPLICIT1", valueStart: 40, valueLength: 11 }),
    ]);
    expect(p!.suggestedFields).toEqual({ key_id: "EXPLICIT1" });
  });

  it("rewrites the identifiers when the key is inline too", () => {
    const [p] = proposalsFor([
      literal({
        action: "app_store_connect_api_key",
        arg: "key_content",
        value: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        pairStart: 4,
        pairLength: 70,
      }),
      literal({ action: "app_store_connect_api_key", arg: "key_id", value: "9K2LM4XY", valueStart: 90, valueLength: 10 }),
    ]);
    expect(p!.tier).toBe("inline");
    expect(p!.edits).toContainEqual({
      start: 90,
      length: 10,
      replacement: 'ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_ID")',
    });
    expect(p!.suggestedFields).toEqual({ key_id: "9K2LM4XY" });
  });

  it("normalises an ENV[...] credential arg to Laneyard's name, without a value to lift", () => {
    const [p] = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_filepath", kind: "env", value: "ASC_KEY_FILEPATH", valueStart: 30, valueLength: 22 }),
    ]);
    expect(p!.kind).toBe("apple_asc");
    expect(p!.edits).toContainEqual({
      start: 30,
      length: 22,
      replacement: 'ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")',
    });
  });

  it("normalises env-ref identifiers too, filling no field from an env name", () => {
    const [p] = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_filepath", kind: "env", value: "ASC_KEY_FILEPATH", valueStart: 30, valueLength: 22 }),
      literal({ action: "app_store_connect_api_key", arg: "issuer_id", kind: "env", value: "ASC_ISSUER_ID", valueStart: 60, valueLength: 20 }),
    ]);
    expect(p!.edits).toContainEqual({
      start: 60,
      length: 20,
      replacement: 'ENV.fetch("APP_STORE_CONNECT_API_KEY_ISSUER_ID")',
    });
    // An env name is not the id's value, so nothing pre-fills the block's field.
    expect(p!.suggestedFields).toEqual({});
  });

  it("emits nothing when the value already reads the canonical name", () => {
    expect(
      proposalsFor([literal({ action: "supply", arg: "json_key", kind: "env", value: "SUPPLY_JSON_KEY" })]),
    ).toEqual([]);
  });

  it("offers a literal secret unchecked, because a false positive is likely", () => {
    const [p] = proposalsFor([literal({ action: "pilot", arg: "api_token", value: "abc123" })]);
    expect(p!.tier).toBe("secret");
    expect(p!.checked).toBe(false);
  });

  it("ignores an empty literal", () => {
    expect(proposalsFor([literal({ action: "pilot", arg: "api_token", value: "" })])).toEqual([]);
  });

  it("ignores an argument nothing recognises", () => {
    expect(proposalsFor([literal({ action: "build_app", arg: "scheme", value: "Runner" })])).toEqual([]);
  });
});

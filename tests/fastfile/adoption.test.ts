import { describe, expect, it } from "vitest";
import { proposalsFor } from "../../src/fastfile/adoption.js";
import type { Literal } from "../../src/sidecar/scan.js";

const literal = (over: Partial<Literal>): Literal => ({
  action: "supply",
  arg: "json_key",
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
    expect(p!.edit).toEqual({ start: 10, length: 13, replacement: 'ENV.fetch("SUPPLY_JSON_KEY")' });
  });

  it("uses the App Store Connect filepath name for a .p8", () => {
    const [p] = proposalsFor([
      literal({ action: "app_store_connect_api_key", arg: "key_filepath", value: "./AuthKey_9K2LM4XY.p8" }),
    ]);
    expect(p!.kind).toBe("apple_asc");
    expect(p!.edit.replacement).toBe('ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")');
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
    expect(p!.edit.start).toBe(4);
    expect(p!.edit.length).toBe(70);
    expect(p!.edit.replacement).toBe('key_filepath: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")');
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

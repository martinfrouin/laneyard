import type { CredentialKind } from "../db/credentials.js";

export type { CredentialKind };

export interface FieldSpec {
  name: string;
  /** Kept out of the logs and never sent back to a browser. */
  secret: boolean;
  label: string;
}

export interface KindSpec {
  kind: CredentialKind;
  what: string;
  accept: string;
  fields: FieldSpec[];
  /** Exported variable names, overridable per block. */
  defaults: Record<string, string>;
}

/**
 * What each kind of credential block is made of — the one table the server,
 * runner, readiness checks, and web UI all read, so an agreement kept in one
 * place instead of copied four times.
 *
 * Apple and Play defaults are the names fastlane itself reads — verified
 * against fastlane 2.237: `app_store_connect_api_key` declares
 * `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH` / `_KEY_ID` / `..._ISSUER_ID`,
 * and `supply` declares `SUPPLY_JSON_KEY`.
 *
 * Android defaults are Laneyard's own — nothing in fastlane reads a keystore
 * by convention. `ANDROID_KEYSTORE_PASSWORD` was not chosen freely: it
 * matches the `/(^|_)(KEYSTORE|STORE)_PASSWORD$/` pattern that
 * `src/heuristics/readiness.ts` already recognises, so the check and the
 * block agree by construction rather than by coincidence.
 */
export const CREDENTIAL_KINDS: KindSpec[] = [
  {
    kind: "apple_asc",
    what: "app store connect key",
    accept: ".p8",
    fields: [
      { name: "key_id", secret: false, label: "Key ID" },
      { name: "issuer_id", secret: false, label: "Issuer ID" },
    ],
    defaults: {
      path: "APP_STORE_CONNECT_API_KEY_KEY_FILEPATH",
      key_id: "APP_STORE_CONNECT_API_KEY_KEY_ID",
      issuer_id: "APP_STORE_CONNECT_API_KEY_ISSUER_ID",
    },
  },
  {
    kind: "android_keystore",
    what: "android upload keystore",
    accept: ".jks,.keystore",
    fields: [
      { name: "key_alias", secret: false, label: "Key alias" },
      { name: "store_password", secret: true, label: "Store password" },
      { name: "key_password", secret: true, label: "Key password" },
    ],
    defaults: {
      path: "ANDROID_KEYSTORE_PATH",
      store_password: "ANDROID_KEYSTORE_PASSWORD",
      key_alias: "ANDROID_KEY_ALIAS",
      key_password: "ANDROID_KEY_PASSWORD",
    },
  },
  {
    kind: "play_service_account",
    what: "play store service account",
    accept: ".json,application/json",
    fields: [],
    defaults: {
      path: "SUPPLY_JSON_KEY",
    },
  },
];

function specOf(kind: CredentialKind): KindSpec {
  const spec = CREDENTIAL_KINDS.find((k) => k.kind === kind);
  if (!spec) throw new Error(`unknown credential kind: ${kind}`);
  return spec;
}

export function defaultVarNames(kind: CredentialKind): Record<string, string> {
  return specOf(kind).defaults;
}

export function fieldsOf(kind: CredentialKind): FieldSpec[] {
  return specOf(kind).fields;
}

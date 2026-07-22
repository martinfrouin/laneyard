import type { CredentialKind } from "../db/credentials.js";

export type { CredentialKind };

export interface FieldSpec {
  name: string;
  /** Kept out of the logs and never sent back to a browser. */
  secret: boolean;
  label: string;
  /**
   * A field the block is usable without, so an empty one does not refuse the
   * block. It exists for the two settings below: a question Laneyard is allowed
   * to ask, never a thing it may require an answer to before it will sign.
   */
  optional?: boolean;
  /**
   * What the form starts out holding. A proposal to correct rather than a blank
   * to fill in — the difference between an answer and homework.
   */
  suggested?: string;
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
      // The two things about a gradle properties file that cannot be deduced.
      // `runner/gradle-properties.ts` writes that file where a build script
      // falls back to the debug key; the script names the file, and says
      // nothing about where the name is resolved when the receiver is a
      // variable, nor about the keys read out of it afterwards. Both are asked
      // here, pre-filled from what detection could tell, and left empty rather
      // than guessed when it could tell nothing.
      {
        name: "properties_path",
        secret: false,
        optional: true,
        label: "Properties file, relative to the app",
      },
      {
        name: "property_names",
        secret: false,
        optional: true,
        suggested: "storeFile,storePassword,keyPassword,keyAlias",
        label: "Names your build reads inside it",
      },
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

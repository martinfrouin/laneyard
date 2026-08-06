/**
 * The variables a run gets from Laneyard itself, whatever the project stores.
 *
 * One list, read from three places, and that is the point. `orchestrate.ts`
 * sets them; `required-secrets.ts` and the readiness checklist must not ask
 * anybody to supply them. Without a shared list the two sides drift, and the
 * drift has a name: a Fastfile written the way `docs/managing.md` says to write
 * it — `ENV.fetch("LANEYARD_BUILD_NUMBER")` — was reported as needing a secret
 * that no one can store, because a stored one is refused on purpose. A checklist
 * that asks for something impossible is a checklist people learn to ignore.
 */

/** The name every run is handed its project's build counter under. */
export const BUILD_NUMBER_VAR = "LANEYARD_BUILD_NUMBER";

/**
 * Set on every run, after the secrets and out of their reach.
 *
 * `CI` is what tells a Fastfile it is not on a laptop, and the two fastlane
 * settings are here for the same reason: a lane may read them, and none of the
 * three is a thing to type into a vault.
 */
export const PROVIDED_BY_LANEYARD: readonly string[] = [
  BUILD_NUMBER_VAR,
  "CI",
  "FASTLANE_SKIP_UPDATE_CHECK",
  "FORCE_COLOR",
];

/** Whether Laneyard supplies this name, so nothing has to ask for it. */
export const isProvidedByLaneyard = (name: string): boolean =>
  PROVIDED_BY_LANEYARD.includes(name);

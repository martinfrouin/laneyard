import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

/**
 * Whether a relative path leaves the directory it is relative to.
 *
 * `normalize` collapses `a/../../b` to `../b`, so one check after it catches
 * both the obvious `../.env` and the roundabout spelling. An absolute path is
 * refused outright: it does not mean "inside the app" under any reading.
 */
function escapesApp(p: string): boolean {
  if (isAbsolute(p)) return true;
  const clean = normalize(p);
  return clean === ".." || clean.startsWith(`..${"/"}`) || clean.startsWith("..\\");
}

/** A slug is used as a folder name and a URL segment. */
const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug: lowercase letters, digits and hyphens only");

/** Build behaviour settings. They can come from the repository or the server. */
export const projectSettingsSchema = z.object({
  // The project this file belongs to. Written by `setup` and read by `remove`,
  // which runs from the app's directory and takes the slug from here rather than
  // from an argument. An identity, not a path — `normaliseAppConfig` leaves it
  // untouched — and the running server ignores it, identifying the project
  // through `config.yml`. Optional so an older file without it still parses.
  slug: slugSchema.optional(),
  fastlane_dir: z.string().default("fastlane"),
  runtime: z.enum(["bundle", "system"]).default("bundle"),
  timeout_minutes: z.number().int().positive().default(60),
  interactive_default: z.boolean().default(false),
  artifact_globs: z.array(z.string()).default([]),
  required_secrets: z.array(z.string()).default([]),
  // Where to write the file the build reads from disk — a gitignored `.env`, a
  // `config.json` for `--dart-define-from-file`. No default: absent means the
  // project wants no such file, which is almost every project, and an empty
  // string would be a path to interpret rather than an absence to respect.
  //
  // Relative to the app directory, like `fastlane_dir`. A path that climbs out
  // of it is refused here rather than at write time: the file holds the values
  // the vault exists to protect, and a configuration must never be able to drop
  // one anywhere on the server. Refusing at load also means the last valid
  // configuration stays live, which is what every other bad value gets.
  env_file: z
    .string()
    .min(1, "env_file: a path, or leave it out")
    .refine((p) => !escapesApp(p), "env_file: a path inside the app, not one that climbs out of it")
    .optional(),
  // What this project builds for. No default: absent means "nobody said", and
  // the readiness checklist falls back to looking at the repository. Setting it
  // is how a repository that happens to carry an Xcode project it never builds
  // stops being asked for App Store Connect credentials.
  platforms: z.array(z.enum(["ios", "android"])).optional(),
  retention: z
    .object({
      runs: z.number().int().positive(),
      artifact_days: z.number().int().positive(),
    })
    .optional(),
});

/** Same vocabulary, but everything is optional in the files. */
export const projectSettingsInputSchema = projectSettingsSchema.partial();

export const projectEntrySchema = projectSettingsInputSchema.extend({
  slug: slugSchema,
  name: z.string().optional(),
  git_url: z.string().min(1),
  default_branch: z.string().default("main"),
  git_auth: z
    .object({
      // `token` is not accepted yet. The workspace only knows how to use an SSH
      // key, so accepting it would leave a project configured for something that
      // silently never happens — worse than a clear refusal at load time.
      kind: z.enum(["none", "ssh_key"]),
      /** Path to the SSH key file. */
      ref: z.string().optional(),
    })
    .default({ kind: "none" }),
  color: z.string().default("green"),
  notify_browser: z.boolean().default(true),
  webhook_url: z.string().optional(),
});

/**
 * Two roles, and only two.
 *
 * A third is easy to add and impossible to remove. These two cover the case
 * that prompted them — someone who ships without being trusted with the
 * signing chain — and two can be held in a reader's head.
 */
export const userRoleSchema = z.enum(["admin", "builder"]);

export const userEntrySchema = z.object({
  // The name is typed into a login form and printed in a status bar; keeping it
  // to a plain identifier avoids a name that reads differently than it is stored.
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "name: letters, digits, dot, dash, underscore"),
  role: userRoleSchema,
  password_hash: z.string().min(1),
  /**
   * Which projects a builder may reach, by slug. Three-way, and the three ways
   * carry back-compat for free:
   *
   *   absent → every project. A file written before this feature has no field
   *     on anyone, so nobody loses access on upgrade.
   *   []     → no project. What account creation now writes, so a new builder
   *     starts with nothing until granted.
   *   a list → exactly those slugs.
   *
   * An `admin` ignores it entirely: managing the server is their whole role.
   */
  projects: z.array(slugSchema).optional(),
});

export const serverConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(7890),
    bind: z.string().default("0.0.0.0"),
    // Optional in the file, required by the loader: a configuration that
    // declares no account is refused rather than started.
    users: z.array(userEntrySchema).optional(),
    // Only 1 is accepted. Runs share one working directory per project, so a
    // higher number would promise parallel builds that never happen — the
    // queue drains one run at a time, whatever this says. Refusing at load
    // time is the honest answer, as with `git_auth: token`.
    max_concurrent_runs: z
      .number()
      .int()
      .positive()
      // Refined on the field itself, so zod reports `server.max_concurrent_runs`
      // on its own: `load.ts` prefixes the message with that path, and an error
      // saying `(root)` would leave the reader hunting for the field.
      .refine((n) => n === 1, {
        message:
          "only 1 is supported: runs are executed one at a time, and accepting more would " +
          "promise parallel builds that never happen",
      })
      .default(1),
    retention: z
      .object({
        runs: z.number().int().positive().default(50),
        artifact_days: z.number().int().positive().default(30),
      })
      .default({ runs: 50, artifact_days: 30 }),
  }),
  projects: z.array(projectEntrySchema).default([]),
});

/** Content of laneyard.yml: build behaviour only. */
export const repoConfigSchema = projectSettingsInputSchema;

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema> & { name: string };
export type UserRole = z.infer<typeof userRoleSchema>;
export type UserEntry = z.infer<typeof userEntrySchema>;

/**
 * The server block once normalised.
 *
 * `users` is required here even though the file leaves it optional: the loader
 * refuses a configuration that declares no account, so nothing downstream has
 * to consider a server with nobody in it.
 */
export type ServerSettings = Omit<z.infer<typeof serverConfigSchema>["server"], "users"> & {
  users: UserEntry[];
};

export type ServerConfig = { server: ServerSettings; projects: ProjectEntry[] };
export type RepoConfig = z.infer<typeof repoConfigSchema>;

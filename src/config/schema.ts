import { z } from "zod";

/** Build behaviour settings. They can come from the repository or the server. */
export const projectSettingsSchema = z.object({
  fastlane_dir: z.string().default("fastlane"),
  runtime: z.enum(["bundle", "system"]).default("bundle"),
  timeout_minutes: z.number().int().positive().default(60),
  interactive_default: z.boolean().default(false),
  artifact_globs: z.array(z.string()).default([]),
  required_secrets: z.array(z.string()).default([]),
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

/** A slug is used as a folder name and a URL segment. */
const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug: lowercase letters, digits and hyphens only");

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

export const serverConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(7890),
    bind: z.string().default("0.0.0.0"),
    password_hash: z.string().min(1),
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
export type ServerConfig = Omit<z.infer<typeof serverConfigSchema>, "projects"> & {
  projects: ProjectEntry[];
};
export type RepoConfig = z.infer<typeof repoConfigSchema>;

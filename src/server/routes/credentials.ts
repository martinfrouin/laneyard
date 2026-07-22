import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import type { CredentialKind } from "../../credentials/kinds.js";
import { CREDENTIAL_KINDS, defaultVarNames, fieldsOf } from "../../credentials/kinds.js";

/**
 * Signing blocks over HTTP: the file and the fields that make it usable.
 *
 * The file arrives base64 inside a JSON body rather than as a multipart upload.
 * No multipart plugin is registered — see `app.ts` — and a `.p8` is two
 * kilobytes, so adding a dependency to carry it would be paying in supply chain
 * for a convenience the browser can provide in one `FileReader` call.
 *
 * A block is taken or refused whole. That is what makes it a block rather than
 * three loose rows: a keystore stored without its alias is not a partial
 * success, it is a build that fails in a month with an unusable artifact.
 */

/** POSIX environment variable names. Anything else would never reach fastlane. */
const VALID_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Body {
  fileName?: unknown;
  fileBase64?: unknown;
  fields?: unknown;
  varNames?: unknown;
}

export async function registerCredentialRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/credentials", async () => ctx.vault.listGlobalCredentials());

  app.get("/api/projects/:slug/credentials", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return ctx.vault.listCredentials(slug);
  });

  const put = async (slug: string | null, kind: string, body: unknown, reply: any) => {
    const spec = CREDENTIAL_KINDS.find((k) => k.kind === kind);
    if (!spec) {
      return reply.code(400).send({
        error: `"${kind}" is not a kind of credential Laneyard knows: ${CREDENTIAL_KINDS.map((k) => k.kind).join(", ")}.`,
      });
    }

    const { fileName, fileBase64, fields, varNames } = (body ?? {}) as Body;
    if (typeof fileName !== "string" || fileName === "") {
      return reply.code(400).send({ error: "A file name is required" });
    }
    if (typeof fileBase64 !== "string" || fileBase64 === "") {
      return reply.code(400).send({ error: `The ${spec.what} file is required, base64-encoded.` });
    }

    const given = (fields ?? {}) as Record<string, unknown>;
    if (typeof given !== "object" || Array.isArray(given)) {
      return reply.code(400).send({ error: "`fields` is an object of name to value." });
    }

    const missing = fieldsOf(spec.kind)
      .filter((f) => typeof given[f.name] !== "string" || given[f.name] === "")
      .map((f) => f.name);
    if (missing.length > 0) {
      return reply.code(400).send({
        error: `A ${spec.what} needs ${missing.join(", ")}. Without it the file alone signs nothing.`,
      });
    }

    // Only the fields the kind declares are kept. An extra one would be stored,
    // never read, and quietly disagree with what the block claims to be.
    const kept: Record<string, string> = {};
    for (const field of fieldsOf(spec.kind)) kept[field.name] = given[field.name] as string;

    const names = { ...defaultVarNames(spec.kind), ...((varNames ?? {}) as Record<string, string>) };
    for (const [slot, name] of Object.entries(names)) {
      if (!(slot in defaultVarNames(spec.kind))) {
        return reply.code(400).send({ error: `A ${spec.what} exports nothing called "${slot}".` });
      }
      if (typeof name !== "string" || !VALID_VAR.test(name)) {
        return reply.code(400).send({
          error: `"${name}" is not a valid environment variable name: letters, digits and underscore, not starting with a digit.`,
        });
      }
    }

    // Node's base64 decoder ignores what it cannot read rather than refusing, so
    // a truncated or mistyped upload would be stored as a shorter file and only
    // surface as an unreadable key at signing time.
    const fileBytes = Buffer.from(fileBase64, "base64");
    if (fileBytes.length === 0 || fileBytes.toString("base64").replace(/=+$/, "") !== fileBase64.replace(/=+$/, "")) {
      return reply.code(400).send({ error: "The file is not valid base64." });
    }

    await ctx.vault.setCredential(slug, spec.kind, { fileName, fileBytes, fields: kept, varNames: names });
    return reply.code(204).send();
  };

  app.put("/api/credentials/:kind", async (req, reply) =>
    put(null, (req.params as { kind: string }).kind, req.body, reply),
  );

  app.put("/api/projects/:slug/credentials/:kind", async (req, reply) => {
    const { slug, kind } = req.params as { slug: string; kind: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return put(slug, kind, req.body, reply);
  });

  app.delete("/api/credentials/:kind", async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const removed = ctx.vault.removeCredential(null, kind as CredentialKind);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Unknown credential" });
  });

  /**
   * Removes this project's own block, and only that one. A global block that
   * was shadowed comes back into view, which is the deletion someone asked for:
   * they are undoing an override, not deleting everyone's key from inside one
   * project.
   */
  app.delete("/api/projects/:slug/credentials/:kind", async (req, reply) => {
    const { slug, kind } = req.params as { slug: string; kind: string };
    const removed = ctx.vault.removeCredential(slug, kind as CredentialKind);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Unknown credential" });
  });
}

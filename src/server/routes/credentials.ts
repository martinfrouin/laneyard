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
  app.get("/api/projects/:slug/credentials", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    // Fields included, secret ones excepted — an alias or a key id that cannot
    // be read cannot be checked, and `stored` says the same thing about a right
    // value and a wrong one. The passwords come one at a time through the route
    // below, so opening the screen still puts none of them in a browser.
    return ctx.vault.listCredentialsWithFields(slug);
  });

  /**
   * One field of one block, in the clear — including a password.
   *
   * The same shape and the same reasoning as revealing a secret: a separate
   * request, for one named field, made because somebody pressed `show`. A block
   * can only be corrected by uploading it again in full, so a password nobody
   * can read is a password that gets replaced by the same typo twice.
   */
  app.get("/api/projects/:slug/credentials/:kind/fields/:field/value", async (req, reply) => {
    const { slug, kind, field } = req.params as { slug: string; kind: string; field: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    const spec = CREDENTIAL_KINDS.find((k) => k.kind === kind);
    if (!spec) return reply.code(404).send({ error: "Unknown credential" });
    if (!spec.fields.some((f) => f.name === field)) {
      return reply.code(404).send({ error: `A ${spec.what} has no field called "${field}".` });
    }

    const value = ctx.vault.revealCredentialField(slug, spec.kind, field);
    if (value === null) return reply.code(404).send({ error: "Unknown credential" });
    return { field, value };
  });

  const put = async (slug: string, kind: string, body: unknown, reply: any) => {
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

    // Optional fields are the settings a block may leave unanswered — where a
    // gradle properties file goes, what it is read under. Laneyard is allowed to
    // ask; refusing the whole block over an unanswered one would be requiring.
    const missing = fieldsOf(spec.kind)
      .filter((f) => !f.optional && (typeof given[f.name] !== "string" || given[f.name] === ""))
      .map((f) => f.name);
    if (missing.length > 0) {
      return reply.code(400).send({
        error: `A ${spec.what} needs ${missing.join(", ")}. Without it the file alone signs nothing.`,
      });
    }

    // Only the fields the kind declares are kept. An extra one would be stored,
    // never read, and quietly disagree with what the block claims to be.
    const kept: Record<string, string> = {};
    for (const field of fieldsOf(spec.kind)) {
      const value = given[field.name];
      // An unanswered optional field is absent from the block rather than
      // stored empty: the reader then falls back to what it would have used
      // anyway, instead of taking "" for an answer someone gave.
      if (typeof value === "string" && value !== "") kept[field.name] = value;
    }

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

  app.put("/api/projects/:slug/credentials/:kind", async (req, reply) => {
    const { slug, kind } = req.params as { slug: string; kind: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });
    return put(slug, kind, req.body, reply);
  });

  /**
   * Corrects fields of a block already stored, the file left alone.
   *
   * `PUT` takes a block whole because a keystore arriving without its alias is
   * not a partial success. That reasoning stops applying the moment the block is
   * in place: a store password typed one character short could only be fixed by
   * uploading the `.jks` again — re-supplying the part nobody doubted, and
   * getting another chance to mistype the part that was wrong.
   *
   * A required field may be corrected, never emptied: an empty one is the state
   * `PUT` refuses, and reaching it through another verb would leave a block that
   * signs nothing behind a screen saying it is in place. An optional one is
   * emptied on purpose — that is how a setting is taken back.
   *
   * The file is one of the things that changes on its own, and the commonest: a
   * `.p8` is rotated far more often than the key id and issuer id beside it.
   */
  app.patch("/api/projects/:slug/credentials/:kind", async (req, reply) => {
    const { slug, kind } = req.params as { slug: string; kind: string };
    if (!ctx.config.project(slug)) return reply.code(404).send({ error: "Unknown project" });

    const spec = CREDENTIAL_KINDS.find((k) => k.kind === kind);
    if (!spec) return reply.code(404).send({ error: "Unknown credential" });

    const { fileName, fileBase64, fields, varNames } = (req.body ?? {}) as Body;

    // The two travel together: a name without bytes would rename the file the
    // run writes without changing what is in it, and bytes without a name would
    // leave `AuthKey_OLD.p8` on screen describing a key that is gone.
    if ((fileName === undefined) !== (fileBase64 === undefined)) {
      return reply.code(400).send({ error: "Send the file and its name together." });
    }
    let file: { fileName: string; fileBytes: Buffer } | undefined;
    if (fileName !== undefined) {
      if (typeof fileName !== "string" || fileName === "") {
        return reply.code(400).send({ error: "A file name is required" });
      }
      if (typeof fileBase64 !== "string" || fileBase64 === "") {
        return reply.code(400).send({ error: `The ${spec.what} file is required, base64-encoded.` });
      }
      // The same check `PUT` makes, and for the same reason: Node's decoder
      // ignores what it cannot read, so a truncated upload would be stored as a
      // shorter file and only surface as an unreadable key at signing time.
      const fileBytes = Buffer.from(fileBase64, "base64");
      if (fileBytes.length === 0 || fileBytes.toString("base64").replace(/=+$/, "") !== fileBase64.replace(/=+$/, "")) {
        return reply.code(400).send({ error: "The file is not valid base64." });
      }
      file = { fileName, fileBytes };
    }

    const given = (fields ?? {}) as Record<string, unknown>;
    if (typeof given !== "object" || Array.isArray(given)) {
      return reply.code(400).send({ error: "`fields` is an object of name to value." });
    }

    const changed: Record<string, string> = {};
    for (const [name, value] of Object.entries(given)) {
      const field = spec.fields.find((f) => f.name === name);
      if (!field) return reply.code(400).send({ error: `A ${spec.what} has no field called "${name}".` });
      if (typeof value !== "string") {
        return reply.code(400).send({ error: `"${name}" is text.` });
      }
      if (value === "" && !field.optional) {
        return reply.code(400).send({
          error: `A ${spec.what} needs ${name}. Without it the file alone signs nothing.`,
        });
      }
      changed[name] = value;
    }

    const names = (varNames ?? {}) as Record<string, string>;
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

    if (!file && Object.keys(changed).length === 0 && Object.keys(names).length === 0) {
      return reply.code(400).send({ error: "Send a field, a name, or a file to change." });
    }

    const updated = await ctx.vault.updateCredential(slug, spec.kind, {
      file,
      fields: changed,
      varNames: names,
    });
    return updated ? reply.code(204).send() : reply.code(404).send({ error: "Unknown credential" });
  });

  app.delete("/api/projects/:slug/credentials/:kind", async (req, reply) => {
    const { slug, kind } = req.params as { slug: string; kind: string };
    const removed = ctx.vault.removeCredential(slug, kind as CredentialKind);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Unknown credential" });
  });
}

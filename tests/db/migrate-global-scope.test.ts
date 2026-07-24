import { describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { openDatabase } from "../../src/db/open.js";
import { migrateGlobalScope } from "../../src/db/migrate-global-scope.js";

const db = (): Db => openDatabase(":memory:");

const putSecret = (d: Db, slug: string, key: string, value: string, masked = 1): void => {
  d.prepare(
    "INSERT INTO secret (project_slug, key, value_enc, masked, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(slug, key, value, masked, "2026-01-01T00:00:00.000Z");
};

const putCredential = (d: Db, slug: string, kind: string, fileName: string): void => {
  d.prepare(
    `INSERT INTO credential (project_slug, kind, file_name, file_enc, fields_enc, var_names, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(slug, kind, fileName, "file-cipher", "fields-cipher", '{"path":"ASC_KEY"}', "2026-01-01T00:00:00.000Z");
};

const secrets = (d: Db): { project_slug: string; key: string; value_enc: string; masked: number }[] =>
  d.prepare("SELECT project_slug, key, value_enc, masked FROM secret ORDER BY project_slug, key").all() as never;

const credentials = (d: Db): { project_slug: string; kind: string; file_name: string }[] =>
  d.prepare("SELECT project_slug, kind, file_name FROM credential ORDER BY project_slug, kind").all() as never;

describe("migrateGlobalScope", () => {
  it("copies a global secret into every project and removes the original", () => {
    const d = db();
    putSecret(d, "", "SENTRY_DSN", "shared-cipher");

    const report = migrateGlobalScope(d, ["alpha", "beta"]);

    expect(secrets(d)).toEqual([
      { project_slug: "alpha", key: "SENTRY_DSN", value_enc: "shared-cipher", masked: 1 },
      { project_slug: "beta", key: "SENTRY_DSN", value_enc: "shared-cipher", masked: 1 },
    ]);
    expect(report.copied).toEqual([{ what: "secret", name: "SENTRY_DSN", slugs: ["alpha", "beta"] }]);
    expect(report.dropped).toEqual([]);
  });

  it("leaves a project's own value alone, and still copies to the others", () => {
    const d = db();
    putSecret(d, "", "TOKEN", "global-cipher");
    putSecret(d, "alpha", "TOKEN", "own-cipher");

    const report = migrateGlobalScope(d, ["alpha", "beta"]);

    // The precedence the merged read had, made permanent: alpha overrode the
    // global one, so alpha keeps what it overrode with.
    expect(secrets(d)).toEqual([
      { project_slug: "alpha", key: "TOKEN", value_enc: "own-cipher", masked: 1 },
      { project_slug: "beta", key: "TOKEN", value_enc: "global-cipher", masked: 1 },
    ]);
    expect(report.copied).toEqual([{ what: "secret", name: "TOKEN", slugs: ["beta"] }]);
  });

  it("carries masked across the copy", () => {
    const d = db();
    putSecret(d, "", "APP_VERSION", "plain-cipher", 0);

    migrateGlobalScope(d, ["alpha"]);

    expect(secrets(d)[0]!.masked).toBe(0);
  });

  it("copies a global signing block into every project and removes the original", () => {
    const d = db();
    putCredential(d, "", "apple_asc", "AuthKey_ABC.p8");

    const report = migrateGlobalScope(d, ["alpha", "beta"]);

    expect(credentials(d)).toEqual([
      { project_slug: "alpha", kind: "apple_asc", file_name: "AuthKey_ABC.p8" },
      { project_slug: "beta", kind: "apple_asc", file_name: "AuthKey_ABC.p8" },
    ]);
    expect(report.copied).toEqual([{ what: "signing block", name: "apple_asc", slugs: ["alpha", "beta"] }]);
  });

  it("carries a block's ciphertext and variable names across the copy", () => {
    const d = db();
    putCredential(d, "", "apple_asc", "AuthKey_ABC.p8");

    migrateGlobalScope(d, ["alpha"]);

    const row = d.prepare("SELECT * FROM credential WHERE project_slug = 'alpha'").get() as {
      file_enc: string;
      fields_enc: string;
      var_names: string;
      updated_at: string;
    };
    expect(row.file_enc).toBe("file-cipher");
    expect(row.fields_enc).toBe("fields-cipher");
    expect(row.var_names).toBe('{"path":"ASC_KEY"}');
    expect(row.updated_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("leaves a project's own block alone", () => {
    const d = db();
    putCredential(d, "", "apple_asc", "global.p8");
    putCredential(d, "alpha", "apple_asc", "own.p8");

    migrateGlobalScope(d, ["alpha", "beta"]);

    expect(credentials(d)).toEqual([
      { project_slug: "alpha", kind: "apple_asc", file_name: "own.p8" },
      { project_slug: "beta", kind: "apple_asc", file_name: "global.p8" },
    ]);
  });

  it("is a no-op the second time, and reports nothing", () => {
    const d = db();
    putSecret(d, "", "SENTRY_DSN", "shared-cipher");
    migrateGlobalScope(d, ["alpha", "beta"]);

    const again = migrateGlobalScope(d, ["alpha", "beta"]);

    expect(again.copied).toEqual([]);
    expect(again.dropped).toEqual([]);
    expect(secrets(d)).toHaveLength(2);
  });

  it("drops a global row when there is no project to copy it into", () => {
    // Leaving it would leave a row nothing reads: after this change every query
    // names a slug, so the empty one is unreachable rather than shared.
    const d = db();
    putSecret(d, "", "SENTRY_DSN", "shared-cipher");
    putCredential(d, "", "apple_asc", "AuthKey_ABC.p8");

    const report = migrateGlobalScope(d, []);

    expect(secrets(d)).toEqual([]);
    expect(credentials(d)).toEqual([]);
    expect(report.copied).toEqual([]);
    expect(report.dropped).toEqual([
      { what: "secret", name: "SENTRY_DSN" },
      { what: "signing block", name: "apple_asc" },
    ]);
  });

  it("reports a global row every project already overrode, which it deletes", () => {
    // Nothing read it — it was shadowed everywhere — so deleting it changes no
    // build. It is still a deletion, and one made in silence could not be
    // audited afterwards.
    const d = db();
    putSecret(d, "", "TOKEN", "global-cipher");
    putSecret(d, "alpha", "TOKEN", "alpha-cipher");
    putSecret(d, "beta", "TOKEN", "beta-cipher");

    const report = migrateGlobalScope(d, ["alpha", "beta"]);

    expect(report.copied).toEqual([]);
    expect(report.dropped).toEqual([{ what: "secret", name: "TOKEN" }]);
    expect(secrets(d)).toHaveLength(2);
  });

  it("ignores an empty slug, which is the sentinel it is deleting", () => {
    // A configuration cannot produce one. If it did, copying into it would land
    // on the row about to be deleted and take the data with it.
    const d = db();
    putSecret(d, "", "TOKEN", "global-cipher");

    const report = migrateGlobalScope(d, ["", "alpha"]);

    expect(secrets(d)).toEqual([
      { project_slug: "alpha", key: "TOKEN", value_enc: "global-cipher", masked: 1 },
    ]);
    expect(report.copied).toEqual([{ what: "secret", name: "TOKEN", slugs: ["alpha"] }]);
  });

  it("does nothing at all to a database that never held a global row", () => {
    const d = db();
    putSecret(d, "alpha", "TOKEN", "own-cipher");

    const report = migrateGlobalScope(d, ["alpha", "beta"]);

    expect(report.copied).toEqual([]);
    expect(report.dropped).toEqual([]);
    expect(secrets(d)).toHaveLength(1);
  });
});

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import { buildApp } from "../../src/server/app.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { CredentialStore } from "../../src/db/credentials.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

async function harness() {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": "lane :beta do\nend\n" });
  const root = await tmpDir("laneyard-credentials-");
  const configPath = join(root, "config.yml");
  await writeFile(
    configPath,
    `
server:
  users:
    - { name: admin, role: admin, password_hash: "${hashPassword("secret")}" }
projects:
  - slug: sample
    name: Sample
    git_url: ${origin}
`,
    "utf8",
  );

  const config = new ConfigStore(configPath);
  await config.load();
  const db = openDatabase(":memory:");

  const app = await buildApp({
    config,
    db,
    root,
    lanes: async () => [{ name: "beta", platform: "ios", description: "Beta", private: false }],
    uses: async () => ({ lanes: [{ lane: "beta", actions: [] }], imports: false }),
    vault: await Vault.open(root, new SecretStore(db), new CredentialStore(db)),
  });

  return { app, root };
}

async function login(app: Awaited<ReturnType<typeof harness>>["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { name: "admin", password: "secret" },
  });
  return res.cookies[0]!.value;
}

const p8 = Buffer.from("-----BEGIN PRIVATE KEY-----\nnot really a key\n").toString("base64");

const appleBlock = {
  fileName: "AuthKey_ABC123.p8",
  fileBase64: p8,
  fields: { key_id: "ABC123", issuer_id: "69a6de70-cafe" },
};

const KEYSTORE_PASSWORD = "a-store-password-nobody-should-see";

const keystoreBlock = {
  fileName: "upload.jks",
  fileBase64: Buffer.from("PK not really a keystore").toString("base64"),
  fields: {
    key_alias: "upload",
    store_password: KEYSTORE_PASSWORD,
    key_password: "a-key-password-nobody-should-see",
  },
};

describe("credential blocks API", () => {
  it("refuses without a session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/credentials" });
    expect(res.statusCode).toBe(401);
  });

  it("stores a block and lists it", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/apple_asc",
      cookies,
      payload: appleBlock,
    });
    expect(put.statusCode).toBe(204);

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/credentials", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      {
        kind: "apple_asc",
        fileName: "AuthKey_ABC123.p8",
        varNames: { key_id: "APP_STORE_CONNECT_API_KEY_KEY_ID" },
      },
    ]);
  });

  // The listing is a listing of names. A page opened to check which blocks
  // exist must not put a keystore password, or the file itself, in a browser.
  it("never carries a field value or a ciphertext", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/android_keystore",
      cookies,
      payload: keystoreBlock,
    });

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/credentials", cookies });
    expect(res.body).not.toContain(KEYSTORE_PASSWORD);
    expect(res.body).not.toContain(keystoreBlock.fileBase64);
    expect(res.body).not.toMatch(/fieldsEnc|fileEnc|fields/i);
  });

  it("refuses a kind it does not know", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/huawei_appgallery",
      cookies,
      payload: { fileName: "key.txt", fileBase64: p8, fields: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  // A keystore without its alias is not a block with a gap in it; it is not a
  // block. Validating it whole is the point of it being one entity.
  it("refuses a block missing a field its kind needs", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/android_keystore",
      cookies,
      payload: { ...keystoreBlock, fields: { key_alias: "upload", store_password: "p" } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/key_password/);
  });

  it("refuses a body with no file", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/apple_asc",
      cookies,
      payload: { fileName: "AuthKey.p8", fields: appleBlock.fields },
    });
    expect(res.statusCode).toBe(400);
  });

  it("deletes a block", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/apple_asc",
      cookies,
      payload: appleBlock,
    });

    const del = await app.inject({
      method: "DELETE",
      url: "/api/projects/sample/credentials/apple_asc",
      cookies,
    });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/projects/sample/credentials", cookies })).json()).toEqual([]);
  });

  it("404s on deleting one that is not there", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/sample/credentials/apple_asc",
      cookies,
    });
    expect(res.statusCode).toBe(404);
  });

  it("is 404 for a project that is not declared", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({ method: "GET", url: "/api/projects/nope/credentials", cookies });
    expect(res.statusCode).toBe(404);
  });

  it("has no way in that does not name a project", async () => {
    // A block used to be storable under no project and read by every one of
    // them. A request that names no project now reaches nothing at all.
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    for (const [method, url] of [
      ["GET", "/api/credentials"],
      ["PUT", "/api/credentials/apple_asc"],
      ["DELETE", "/api/credentials/apple_asc"],
    ] as const) {
      const res = await app.inject({ method, url, cookies, payload: appleBlock });
      expect(res.statusCode).toBe(404);
    }
  });

  it("replaces a block of the same kind rather than keeping two", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    for (const fileName of ["AuthKey_FIRST.p8", "AuthKey_SECOND.p8"]) {
      await app.inject({
        method: "PUT",
        url: "/api/projects/sample/credentials/apple_asc",
        cookies,
        payload: { ...appleBlock, fileName },
      });
    }

    const listed = (await app.inject({ method: "GET", url: "/api/projects/sample/credentials", cookies })).json();
    expect(listed).toMatchObject([{ kind: "apple_asc", fileName: "AuthKey_SECOND.p8" }]);
    expect(listed.length).toBe(1);

    // Deleting it leaves the project with none of that kind — there is nothing
    // underneath for it to fall back to.
    await app.inject({ method: "DELETE", url: "/api/projects/sample/credentials/apple_asc", cookies });
    expect((await app.inject({ method: "GET", url: "/api/projects/sample/credentials", cookies })).json()).toEqual([]);
  });

  it("takes the variable names it is given, and defaults the rest", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/apple_asc",
      cookies,
      payload: { ...appleBlock, varNames: { key_id: "ASC_KEY_ID" } },
    });

    expect((await app.inject({ method: "GET", url: "/api/projects/sample/credentials", cookies })).json()).toMatchObject(
      [
        {
          varNames: {
            key_id: "ASC_KEY_ID",
            issuer_id: "APP_STORE_CONNECT_API_KEY_ISSUER_ID",
            path: "APP_STORE_CONNECT_API_KEY_KEY_FILEPATH",
          },
        },
      ],
    );
  });

  it("refuses a variable name that could never reach fastlane", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/sample/credentials/apple_asc",
      cookies,
      payload: { ...appleBlock, varNames: { key_id: "not-a-name" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

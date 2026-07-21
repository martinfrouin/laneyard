import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/server/auth.js";
import { buildApp } from "../../src/server/app.js";
import { ConfigStore } from "../../src/config/store.js";
import { openDatabase } from "../../src/db/open.js";
import { SecretStore } from "../../src/db/secrets.js";
import { Vault } from "../../src/secrets/vault.js";
import type { Check } from "../../src/heuristics/readiness.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

/**
 * Every case here clones a real repository and asks a real git for its
 * branches. That is the point — the checklist shells out — and it is also why
 * five seconds is not enough when the whole suite runs at once.
 */
const SLOW = 60_000;

const FASTFILE = "lane :beta do\n  match(readonly: false)\nend\n";

const USES = [{ lane: "beta", actions: [{ name: "match", args: { readonly: false } }] }];

async function harness(options: { gitUrl?: string; uses?: () => Promise<unknown> } = {}) {
  const origin = await makeOriginRepo({ "fastlane/Fastfile": FASTFILE });
  const root = await tmpDir("laneyard-readiness-");
  const configPath = join(root, "config.yml");
  await writeFile(
    configPath,
    `
server:
  password_hash: "${hashPassword("secret")}"
projects:
  - slug: sample
    name: Sample
    git_url: ${options.gitUrl ?? origin}
`,
    "utf8",
  );

  const config = new ConfigStore(configPath);
  await config.load();
  const db = openDatabase(":memory:");

  const uses = vi.fn(options.uses ?? (async () => USES));

  const app = await buildApp({
    config,
    db,
    root,
    lanes: async () => [{ name: "beta", platform: "ios", description: "Beta", private: false }],
    uses: uses as never,
    vault: await Vault.open(root, new SecretStore(db)),
  });

  return { app, root, uses };
}

async function login(app: Awaited<ReturnType<typeof harness>>["app"]): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "secret" } });
  return res.cookies[0]!.value;
}

const byId = (checks: Check[], id: string): Check => checks.find((c) => c.id === id)!;

describe("readiness API", () => {
  it("refuses without a session", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness" });
    expect(res.statusCode).toBe(401);
  }, SLOW);

  it("404s on an unknown project", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/readiness", cookies });
    expect(res.statusCode).toBe(404);
  }, SLOW);

  it("returns the five checks and when they were run", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { checkedAt: string; checks: Check[] };
    expect(body.checks).toHaveLength(5);
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    // The repository is a real local clone source: it answers without a password.
    expect(byId(body.checks, "repository").state).toBe("ok");
  }, SLOW);

  it("reports a lane that calls match with readonly: false and no MATCH_PASSWORD", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    const checks = (res.json() as { checks: Check[] }).checks;
    const match = byId(checks, "match");
    expect(match.state).toBe("warn");
    expect(match.detail).toMatch(/MATCH_PASSWORD/);
    expect(byId(checks, "blocking-actions").state).toBe("warn");
  }, SLOW);

  it("changes its answer once the secret is stored", async () => {
    const { app } = await harness();
    const cookies = { laneyard_session: await login(app) };

    await app.inject({
      method: "PUT",
      url: "/api/projects/sample/secrets/MATCH_PASSWORD",
      cookies,
      payload: { value: "a-long-enough-passphrase" },
    });

    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    const match = byId((res.json() as { checks: Check[] }).checks, "match");
    // Still a warning, but a different one: the passphrase is there, the call
    // is not readonly. The checklist moved on to the next thing.
    expect(match.state).toBe("warn");
    expect(match.detail).toMatch(/readonly: false/);
    expect(match.detail).not.toMatch(/MATCH_PASSWORD is not/);
  }, SLOW);

  it("does not fail as a whole when the sidecar cannot read the lanes", async () => {
    const { app } = await harness({
      uses: async () => {
        throw new Error("Ruby cannot load fastlane");
      },
    });
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    expect(res.statusCode).toBe(200);
    const checks = (res.json() as { checks: Check[] }).checks;
    expect(byId(checks, "match").state).toBe("unknown");
    expect(byId(checks, "match").detail).toMatch(/Ruby cannot load fastlane/);
    expect(byId(checks, "blocking-actions").state).toBe("unknown");
    // The checks that do not depend on the sidecar are unaffected.
    expect(byId(checks, "repository").state).toBe("ok");
  }, SLOW);

  it("says it could not tell, rather than lying, when the workspace is unreachable", async () => {
    const { app } = await harness({ gitUrl: "/nonexistent/laneyard-not-a-repo.git" });
    const cookies = { laneyard_session: await login(app) };
    const res = await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });

    expect(res.statusCode).toBe(200);
    const checks = (res.json() as { checks: Check[] }).checks;
    expect(byId(checks, "repository").state).toBe("warn");
    expect(byId(checks, "dependencies").state).toBe("unknown");
    expect(byId(checks, "match").state).toBe("unknown");
  }, SLOW);

  it("is never computed on its own — only when asked for", async () => {
    const { app, uses } = await harness();
    const cookies = { laneyard_session: await login(app) };

    // The screens a browser opens first. None of them shells out to git or bundler.
    await app.inject({ method: "GET", url: "/api/projects", cookies });
    await app.inject({ method: "GET", url: "/api/projects/sample/runs", cookies });
    await app.inject({ method: "GET", url: "/api/projects/sample/secrets", cookies });
    expect(uses).not.toHaveBeenCalled();

    await app.inject({ method: "GET", url: "/api/projects/sample/readiness", cookies });
    expect(uses).toHaveBeenCalledTimes(1);
  }, SLOW);
});

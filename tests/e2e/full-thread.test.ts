import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerFromConfig } from "../../src/main.js";
import { hashPassword } from "../../src/server/auth.js";
import { RunStore } from "../../src/db/runs.js";
import { makeOriginRepo, tmpDir } from "../fixtures/repos.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "fake-fastlane");

describe("full thread", () => {
  it("declares, clones, lists, launches, follows, and retrieves the artifact", async () => {
    const origin = await makeOriginRepo({
      "fastlane/Fastfile": "lane :beta do\nend\n",
      "laneyard.yml": 'runtime: system\nartifact_globs: ["build/**/*.ipa"]\n',
      ".gitignore": "build/\n",
    });
    const root = await tmpDir("laneyard-e2e-");

    await writeFile(
      join(root, "config.yml"),
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

    process.env["PATH"] = `${FAKE_DIR}:${process.env["PATH"]}`;
    process.env["FAKE_FASTLANE_SCENARIO"] = "success";

    const { app, db } = await createServerFromConfig(root);
    const session = (
      await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { name: "admin", password: "secret" },
      })
    ).cookies[0]!.value;
    const cookies = { laneyard_session: session };

    const projects = await app.inject({ method: "GET", url: "/api/projects", cookies });
    expect(projects.json()).toMatchObject([{ slug: "sample" }]);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/sample/runs",
      cookies,
      payload: { lane: "beta", params: {} },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: number };

    // The run is asynchronous: we wait for it to reach a terminal state.
    const runs = new RunStore(db);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = runs.get(id)?.status;
      if (status === "success" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const detail = await app.inject({ method: "GET", url: `/api/runs/${id}`, cookies });
    const body = detail.json() as { status: string; steps: unknown[]; artifacts: { id: number; filename: string }[] };

    expect(body.status).toBe("success");
    expect(body.steps).toHaveLength(2);
    expect(body.artifacts[0]!.filename).toBe("Sample.ipa");

    const log = await app.inject({ method: "GET", url: `/api/runs/${id}/log`, cookies });
    expect(log.body).toContain("Step: build_app");

    const download = await app.inject({
      method: "GET",
      url: `/api/runs/${id}/artifacts/${body.artifacts[0]!.id}`,
      cookies,
    });
    expect(download.statusCode).toBe(200);
    expect(download.body.trim()).toBe("fake binary");

    await app.close();
  }, 120_000);
});

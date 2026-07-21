import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readReport } from "../../src/runner/report.js";
import { tmpDir } from "../fixtures/repos.js";

// Forme réelle observée : les actions réussies sont auto-fermantes.
const OK = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="fastlane.lanes">
    <testcase classname="fastlane.lanes" name="0: match" time="11.5"/>
    <testcase classname="fastlane.lanes" name="1: build_app" time="238.25"/>
  </testsuite>
</testsuites>`;

// Rapport mixte : c'est le cas qui piège un motif mal ordonné.
const FAILED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="fastlane.lanes">
    <testcase classname="fastlane.lanes" name="0: match" time="1.0"/>
    <testcase classname="fastlane.lanes" name="1: build_app" time="12.0">
      <failure message="Error building the application"></failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe("readReport", () => {
  it("extrait nom, index et durée de chaque action", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), OK, "utf8");
    const steps = await readReport(join(dir, "report.xml"));

    expect(steps).toEqual([
      { idx: 0, name: "match", durationMs: 11_500, status: "success" },
      { idx: 1, name: "build_app", durationMs: 238_250, status: "success" },
    ]);
  });

  it("n'attribue l'échec qu'à l'action concernée dans un rapport mixte", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), FAILED, "utf8");
    const steps = await readReport(join(dir, "report.xml"));
    // Restreint le type autant que ça vérifie : la suite indexe le tableau.
    if (!steps) throw new Error("rapport attendu");

    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe("success");
    expect(steps[1]!.name).toBe("build_app");
    expect(steps[1]!.status).toBe("failed");
  });

  it("renvoie null si le rapport n'existe pas", async () => {
    const dir = await tmpDir("laneyard-rep-");
    expect(await readReport(join(dir, "report.xml"))).toBeNull();
  });

  it("renvoie null sur un rapport illisible plutôt que de lever", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), "<testsuites", "utf8");
    expect(await readReport(join(dir, "report.xml"))).toBeNull();
  });
});

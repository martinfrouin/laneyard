import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readReport } from "../../src/runner/report.js";
import { tmpDir } from "../fixtures/repos.js";

// Real form observed: successful actions are self-closing.
const OK = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="fastlane.lanes">
    <testcase classname="fastlane.lanes" name="0: match" time="11.5"/>
    <testcase classname="fastlane.lanes" name="1: build_app" time="238.25"/>
  </testsuite>
</testsuites>`;

// Mixed report: this is the case that traps a badly ordered pattern.
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
  it("extracts name, index, and duration for each action", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), OK, "utf8");
    const steps = await readReport(join(dir, "report.xml"));

    expect(steps).toEqual([
      { idx: 0, name: "match", durationMs: 11_500, status: "success" },
      { idx: 1, name: "build_app", durationMs: 238_250, status: "success" },
    ]);
  });

  it("attributes the failure only to the action concerned in a mixed report", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), FAILED, "utf8");
    const steps = await readReport(join(dir, "report.xml"));
    // Narrows the type as much as it verifies: the rest of the test indexes the array.
    if (!steps) throw new Error("expected report");

    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe("success");
    expect(steps[1]!.name).toBe("build_app");
    expect(steps[1]!.status).toBe("failed");
  });

  it("decodes the XML entities in an action's name", async () => {
    const dir = await tmpDir("laneyard-rep-");
    // Real case: a `sh` action's name is the command, escaped by the report.
    await writeFile(
      join(dir, "report.xml"),
      `<testsuites><testsuite name="fastlane.lanes">
         <testcase classname="fastlane.lanes" name="0: mkdir -p b &amp;&amp; echo x &gt; y" time="0.1"/>
       </testsuite></testsuites>`,
      "utf8",
    );
    const steps = await readReport(join(dir, "report.xml"));
    expect(steps?.[0]?.name).toBe("mkdir -p b && echo x > y");
  });

  it("returns null if the report doesn't exist", async () => {
    const dir = await tmpDir("laneyard-rep-");
    expect(await readReport(join(dir, "report.xml"))).toBeNull();
  });

  it("returns null on an unreadable report rather than throwing", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(join(dir, "report.xml"), "<testsuites", "utf8");
    expect(await readReport(join(dir, "report.xml"))).toBeNull();
  });
});

describe("readReport — unreliable indexes", () => {
  it("renumbers duplicate indexes rather than letting them into the database", async () => {
    const dir = await tmpDir("laneyard-rep-");
    // Two testsuites, each renumbering from 0: run_step's primary key
    // (run_id, idx) would refuse the insert.
    await writeFile(
      join(dir, "report.xml"),
      `<testsuites>
         <testsuite name="fastlane.lanes">
           <testcase classname="fastlane.lanes" name="0: match" time="1"/>
         </testsuite>
         <testsuite name="fastlane.lanes">
           <testcase classname="fastlane.lanes" name="0: build_app" time="2"/>
           <testcase classname="fastlane.lanes" name="no index" time="3"/>
         </testsuite>
       </testsuites>`,
      "utf8",
    );

    const steps = await readReport(join(dir, "report.xml"));
    if (!steps) throw new Error("expected report");

    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.idx)).toEqual([0, 1, 2]);
    expect(new Set(steps.map((s) => s.idx)).size).toBe(3);
  });

  it("lets an out-of-range numeric entity through without throwing", async () => {
    const dir = await tmpDir("laneyard-rep-");
    await writeFile(
      join(dir, "report.xml"),
      '<testsuites><testsuite name="l"><testcase name="0: &#9999999999;" time="1"/></testsuite></testsuites>',
      "utf8",
    );
    await expect(readReport(join(dir, "report.xml"))).resolves.toHaveLength(1);
  });
});

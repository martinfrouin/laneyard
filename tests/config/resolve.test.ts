import { describe, expect, it } from "vitest";
import { resolveProjectSettings } from "../../src/config/resolve.js";
import type { ProjectEntry } from "../../src/config/schema.js";

const entry = (over: Partial<ProjectEntry> = {}): ProjectEntry => ({
  slug: "p",
  name: "p",
  git_url: "u",
  default_branch: "main",
  git_auth: { kind: "none" },
  color: "green",
  notify_browser: true,
  ...over,
});

describe("resolveProjectSettings", () => {
  it("retombe sur les défauts quand rien n'est défini", () => {
    const r = resolveProjectSettings(entry(), null);
    expect(r.settings.fastlane_dir).toBe("fastlane");
    expect(r.settings.timeout_minutes).toBe(60);
    expect(r.provenance.fastlane_dir).toBe("default");
  });

  it("le bloc du projet l'emporte sur les défauts", () => {
    const r = resolveProjectSettings(entry({ timeout_minutes: 15 }), null);
    expect(r.settings.timeout_minutes).toBe(15);
    expect(r.provenance.timeout_minutes).toBe("server");
  });

  it("le dépôt l'emporte sur le bloc du projet", () => {
    const r = resolveProjectSettings(entry({ timeout_minutes: 15 }), { timeout_minutes: 90 });
    expect(r.settings.timeout_minutes).toBe(90);
    expect(r.provenance.timeout_minutes).toBe("repo");
  });

  it("mélange les provenances champ par champ", () => {
    const r = resolveProjectSettings(entry({ runtime: "system" }), {
      artifact_globs: ["build/*.ipa"],
    });
    expect(r.settings.runtime).toBe("system");
    expect(r.provenance.runtime).toBe("server");
    expect(r.settings.artifact_globs).toEqual(["build/*.ipa"]);
    expect(r.provenance.artifact_globs).toBe("repo");
    expect(r.provenance.fastlane_dir).toBe("default");
  });

  it("traite un tableau vide comme une valeur définie, pas comme une absence", () => {
    const r = resolveProjectSettings(entry(), { artifact_globs: [] });
    expect(r.provenance.artifact_globs).toBe("repo");
  });
});

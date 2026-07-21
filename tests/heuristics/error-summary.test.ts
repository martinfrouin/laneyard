import { describe, expect, it } from "vitest";
import { summarizeFailure } from "../../src/heuristics/error-summary.js";

/** Fin de sortie observée sur un vrai run échoué, séquences ANSI comprises. */
const REAL_TAIL = [
  "[13:19:32]: [31mCalled from Fastfile at line 7[0m",
  '[13:19:32]:  => 7:\t  UI.user_error!("signature refusée par le trousseau")',
  "[13:19:32]: [31mfastlane finished with errors[0m",
  "[31m[!] signature refusée par le trousseau[0m",
].join("\n");

describe("summarizeFailure", () => {
  it("retient la cause marquée par fastlane, sans ANSI ni marqueur", () => {
    expect(summarizeFailure(REAL_TAIL, 1)).toBe("signature refusée par le trousseau");
  });

  it("écarte le message générique de fin, qui n'apprend rien", () => {
    const log = "[13:19:32]: Compiling\n[13:19:32]: fastlane finished with errors";
    expect(summarizeFailure(log, 1)).not.toMatch(/finished with errors/);
  });

  it("retombe sur une ligne parlant d'erreur quand le marqueur manque", () => {
    const log = "[10:00:00]: Compiling\n[10:00:01]: error: no signing certificate found\n[10:00:02]: bye";
    expect(summarizeFailure(log, 65)).toBe("error: no signing certificate found");
  });

  it("retombe sur le code de sortie quand la sortie n'apprend rien", () => {
    expect(summarizeFailure("[10:00:00]: tout va bien", 65)).toBe(
      "fastlane s'est arrêté avec le code 65",
    );
  });

  it("reste lisible quand le run n'a produit aucune sortie", () => {
    expect(summarizeFailure("", null)).toBe("Le run a échoué sans message exploitable");
  });

  it("tronque une cause démesurée plutôt que d'inonder la liste", () => {
    expect(summarizeFailure(`[!] ${"x".repeat(900)}`, 1)).toHaveLength(500);
  });
});

import { describe, expect, it } from "vitest";
import { gitEnvFor } from "../../src/git/workspace.js";

/**
 * What a lane's own `git push` inherits.
 *
 * This is not only Laneyard's own concern: a Fastfile that bumps a build number
 * and pushes it is ordinary, and that `sh("git push")` used to inherit nothing.
 * It got the worst failure available — a push needing a credential did not
 * fail, it waited, and the run sat there until its timeout.
 */
describe("gitEnvFor", () => {
  it("always refuses a credentials prompt, so a push fails instead of waiting", () => {
    expect(gitEnvFor({ kind: "none" })["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("hands over the key the project clones with, which is the key it pushes with", () => {
    const env = gitEnvFor({ kind: "ssh_key", ref: "/keys/deploy" });
    expect(env["GIT_SSH_COMMAND"]).toContain("/keys/deploy");
    expect(env["GIT_SSH_COMMAND"]).toContain("IdentitiesOnly=yes");
    // Without BatchMode, ssh asks for a passphrase and waits — the same hang by
    // another route.
    expect(env["GIT_SSH_COMMAND"]).toContain("BatchMode=yes");
  });

  it("names no ssh command when there is no key to name", () => {
    expect(gitEnvFor({ kind: "none" })["GIT_SSH_COMMAND"]).toBeUndefined();
    expect(gitEnvFor({ kind: "ssh_key" })["GIT_SSH_COMMAND"]).toBeUndefined();
  });
});

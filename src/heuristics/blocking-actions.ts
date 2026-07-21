/**
 * Actions known to stop and wait for a human.
 *
 * Named knowledge of fastlane, hence its place in this module. It is a table
 * rather than code so that it stays legible as fastlane changes, and so that
 * adding an entry is not an invitation to add a branch.
 *
 * `when` is what makes an action blocking. Absent, it always is; present, only
 * when the lane calls it that way. `match(readonly: true)` is fine; the same
 * action allowed to create certificates will ask for an Apple account.
 */
export interface BlockingRule {
  action: string;
  when?: { arg: string; equals: unknown };
  because: string;
  fix: string;
}

export const BLOCKING_RULES: BlockingRule[] = [
  {
    action: "prompt",
    because: "asks a question and waits for an answer",
    fix: "Remove it from the lane, or give it a default that applies when `CI` is set.",
  },
  {
    action: "match",
    when: { arg: "readonly", equals: false },
    because: "may create certificates, which needs an Apple account interactively",
    fix: "Pass `readonly: true` so it only fetches what already exists.",
  },
  {
    action: "sync_code_signing",
    when: { arg: "readonly", equals: false },
    because: "may create certificates, which needs an Apple account interactively",
    fix: "Pass `readonly: true` so it only fetches what already exists.",
  },
  {
    action: "sigh",
    because: "renews provisioning profiles, which needs an Apple account interactively",
    fix: "Use `match` in readonly mode instead, with profiles stored in a repository.",
  },
  {
    action: "cert",
    because: "creates or downloads a signing certificate, which needs an Apple account interactively",
    fix: "Use `match` in readonly mode instead, with certificates stored in a repository.",
  },
  // `deliver` renders an HTML summary and waits for a yes before uploading.
  // Only reported when the lane says `force: false` outright: the default is
  // not something the sidecar reports, and inventing one would be a guess.
  {
    action: "deliver",
    when: { arg: "force", equals: false },
    because: "shows a summary and waits for it to be confirmed before uploading",
    fix: "Pass `force: true` so it uploads without asking.",
  },
  {
    action: "upload_to_app_store",
    when: { arg: "force", equals: false },
    because: "shows a summary and waits for it to be confirmed before uploading",
    fix: "Pass `force: true` so it uploads without asking.",
  },
];

/** What the sidecar's `uses` command reports for a single call: the action's
 * name and its literal keyword arguments only. */
export interface UsedAction {
  name: string;
  args: Record<string, unknown>;
}

export interface BlockingFinding {
  action: string;
  because: string;
  fix: string;
}

/**
 * Applies the table to the actions a lane calls.
 *
 * A rule whose `when` names an argument the lane didn't pass literally is not
 * reported: the sidecar already dropped that argument rather than guess at
 * it (see `ruby/introspect.rb`), so `arg in action.args` is false and the
 * rule stays silent instead of pretending to know the answer.
 */
export function findBlockingActions(actions: UsedAction[]): BlockingFinding[] {
  const findings: BlockingFinding[] = [];

  for (const action of actions) {
    for (const rule of BLOCKING_RULES) {
      if (rule.action !== action.name) continue;
      if (rule.when && action.args[rule.when.arg] !== rule.when.equals) continue;

      findings.push({ action: rule.action, because: rule.because, fix: rule.fix });
    }
  }

  return findings;
}

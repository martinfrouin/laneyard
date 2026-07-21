import { createInterface } from "node:readline/promises";

/**
 * The few terminal questions `laneyard setup` needs.
 *
 * Deliberately small: no dependency, no framework, no spinner. A setup command
 * that a user runs once should not drag in a UI toolkit.
 */
export interface Asker {
  /**
   * Shows a proposed value and returns it, or whatever the user typed instead.
   * `hint` is printed above the question, for the ones whose wording cannot
   * carry the explanation on its own.
   */
  ask(label: string, proposed: string, hint?: string): Promise<string>;
  /** A yes/no question. `defaultYes` decides what a bare Return means. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  close(): void;
}

/** Reads from the real terminal. */
export function terminalAsker(): Asker {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return {
    async ask(label, proposed, hint) {
      if (hint) process.stdout.write(`\n  ${hint}\n`);
      // The proposal is shown in the prompt rather than typed for the user:
      // pressing Return accepts it, which is what someone does nine times out
      // of ten, and correcting it costs one line.
      const answer = (await rl.question(`  ${label} [${proposed}]: `)).trim();
      return answer === "" ? proposed : answer;
    },
    async confirm(question, defaultYes) {
      const suffix = defaultYes ? "[Y/n]" : "[y/N]";
      const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (answer === "") return defaultYes;
      return answer.startsWith("y");
    },
    close() {
      rl.close();
    },
  };
}

/** Accepts every proposal without asking. Used by `--yes` and by the tests. */
export const acceptingAsker: Asker = {
  async ask(_label, proposed) {
    return proposed;
  },
  async confirm(_question, defaultYes) {
    return defaultYes;
  },
  close() {},
};

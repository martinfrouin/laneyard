import pty from "node-pty";

export interface PtyRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onData: (chunk: string) => void;
  timeoutMs?: number;
}

export interface PtyRunResult {
  exitCode: number;
  signal: number | null;
  timedOut: boolean;
}

export interface PtyHandle {
  write(input: string): void;
  kill(signal?: string): void;
}

/**
 * Lance une commande dans un pseudo-terminal.
 *
 * Le PTY sert deux buts : fastlane se croit dans un vrai terminal et garde son
 * affichage habituel, et une saisie reste possible si un jour un run en demande une.
 */
export function startPty(opts: PtyRunOptions): { handle: PtyHandle; done: Promise<PtyRunResult> } {
  let proc: pty.IPty;
  try {
    proc = pty.spawn(opts.command, opts.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.cwd,
      env: opts.env as Record<string, string>,
    });
  } catch (cause) {
    // Commande introuvable : selon la plateforme, node-pty lève ou rend 127.
    // On uniformise pour que l'appelant n'ait qu'un seul cas à traiter.
    opts.onData(`\nLancement impossible : ${(cause as Error).message}\n`);
    return {
      handle: { write: () => {}, kill: () => {} },
      done: Promise.resolve({ exitCode: 127, signal: null, timedOut: false }),
    };
  }

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  proc.onData(opts.onData);

  const done = new Promise<PtyRunResult>((resolve) => {
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        // SIGINT d'abord : fastlane fait son ménage. SIGKILL si l'obstination persiste.
        try {
          proc.kill("SIGINT");
        } catch {
          /* le processus a pu mourir entre-temps */
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* idem */
          }
        }, 5000);
      }, opts.timeoutMs);
    }

    proc.onExit(({ exitCode, signal }) => {
      if (timer) clearTimeout(timer);
      // `waitpid` ne renseigne un code de sortie que pour une fin normale : un
      // processus tué par signal laisse 0, ce qui ferait passer une annulation
      // pour une réussite. On applique la convention du shell, 128 + signal,
      // pour qu'un code de sortie reste toujours interprétable.
      const killed = signal !== undefined && signal !== 0;
      resolve({
        exitCode: killed && exitCode === 0 ? 128 + signal : exitCode,
        signal: signal ?? null,
        timedOut,
      });
    });
  });

  const handle: PtyHandle = {
    write: (input) => proc.write(input),
    kill: (signal = "SIGINT") => {
      try {
        proc.kill(signal);
      } catch {
        /* déjà terminé */
      }
    },
  };

  return { handle, done };
}

/** Variante bloquante, pratique pour les tests et les commandes courtes. */
export async function runInPty(opts: PtyRunOptions): Promise<PtyRunResult> {
  return startPty(opts).done;
}

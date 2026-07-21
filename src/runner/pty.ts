import pty from "node-pty";

export interface PtyRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onData: (chunk: string) => void;
  timeoutMs?: number;
  /** Aborting stops the process, with the same escalation as the timeout. */
  signal?: AbortSignal;
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
 * Runs a command in a pseudo-terminal.
 *
 * The PTY serves two purposes: fastlane believes it's in a real terminal and
 * keeps its usual display, and input remains possible if a run ever needs one.
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
    // Command not found: depending on the platform, node-pty throws or returns 127.
    // We normalize so the caller only has one case to handle.
    opts.onData(`\nCould not launch: ${(cause as Error).message}\n`);
    return {
      handle: { write: () => {}, kill: () => {} },
      done: Promise.resolve({ exitCode: 127, signal: null, timedOut: false }),
    };
  }

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  proc.onData(opts.onData);

  /**
   * SIGINT first so fastlane can clean up after itself; SIGKILL five seconds
   * later if it will not. One path, so cancelling and timing out cannot drift
   * apart — and so neither can leave the single worker blocked.
   */
  const stop = (): void => {
    try {
      proc.kill("SIGINT");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5000);
  };

  opts.signal?.addEventListener("abort", stop, { once: true });

  const done = new Promise<PtyRunResult>((resolve) => {
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, opts.timeoutMs);
    }

    proc.onExit(({ exitCode, signal }) => {
      if (timer) clearTimeout(timer);
      // The listener would otherwise accumulate on every run sharing a
      // long-lived signal (the queue's per-run AbortController is not one,
      // but nothing here should depend on that).
      opts.signal?.removeEventListener("abort", stop);
      // `waitpid` only reports an exit code for a normal end: a process
      // killed by a signal leaves 0, which would pass a cancellation off
      // as a success. We apply the shell convention, 128 + signal, so an
      // exit code always stays interpretable.
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
        /* already finished */
      }
    },
  };

  return { handle, done };
}

/** Blocking variant, handy for tests and short commands. */
export async function runInPty(opts: PtyRunOptions): Promise<PtyRunResult> {
  return startPty(opts).done;
}

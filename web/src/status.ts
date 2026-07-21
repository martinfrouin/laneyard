/**
 * The status reads like a character, never like an icon: it's the same
 * grammar as the terminal the run's output comes from.
 */
export const MARK: Record<string, string> = {
  success: "✓",
  failed: "✗",
  interrupted: "✗",
  cancelled: "✗",
  running: "▸",
  preparing: "▸",
  queued: "○",
};

export const mark = (status: string | null | undefined): string => MARK[status ?? "queued"] ?? "○";

/** 1 → 1st, 2 → 2nd. A place in a line reads as a rank, not as a number. */
export function ordinal(n: number): string {
  const teens = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teens ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
}

/**
 * What a status line says.
 *
 * A waiting run says where it is waiting — on the run screen and in a run list
 * alike, in the same words: the same fact stated twice differently reads as two
 * different facts.
 */
export function statusLabel(status: string, queuePosition: number | null): string {
  if (status !== "queued") return status;
  if (queuePosition === null) return "waiting";
  return queuePosition === 1 ? "waiting · next in queue" : `waiting · ${ordinal(queuePosition)} in queue`;
}

/**
 * The readiness checklist reads in the same three characters as a run.
 *
 * `✓` settled, `▸` something to look at, `○` nothing to say — deliberately the
 * same vocabulary, so a green tick means the same thing on every screen.
 */
export const CHECK_MARK: Record<string, string> = { ok: "✓", warn: "▸", unknown: "○" };

export const checkMark = (state: string): string => CHECK_MARK[state] ?? "○";

/**
 * A warning borrows the running colour, and an undetermined check the queued
 * one. No check is ever red: none of them is a failure, and none of them stops
 * anything — colouring one like a failed run would say otherwise.
 */
export const checkClass = (state: string): string =>
  state === "ok" ? "status-success" : state === "warn" ? "status-running" : "status-queued";

/** A run that hasn't finished keeps moving: the interface must follow it. */
export const isActive = (status: string): boolean =>
  status === "queued" || status === "preparing" || status === "running";

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

/** A run that hasn't finished keeps moving: the interface must follow it. */
export const isActive = (status: string): boolean =>
  status === "queued" || status === "preparing" || status === "running";

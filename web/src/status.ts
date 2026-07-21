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

/** A run that hasn't finished keeps moving: the interface must follow it. */
export const isActive = (status: string): boolean =>
  status === "queued" || status === "preparing" || status === "running";

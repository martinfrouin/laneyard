/**
 * L'état se lit comme un caractère, jamais comme une icône : c'est la même
 * grammaire que le terminal d'où sort le run.
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

/** Un run non terminé continue de bouger : l'interface doit le suivre. */
export const isActive = (status: string): boolean =>
  status === "queued" || status === "preparing" || status === "running";

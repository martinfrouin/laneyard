import { amber, bold, dim } from "./style.js";

export async function latestVersion(timeoutMs = 2000): Promise<string | null> {
  try {
    const response = await fetch("https://registry.npmjs.org/laneyard/latest", {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const { version } = (await response.json()) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function updateNotice(current: string, latest: string | null): string {
  if (latest === null || !isNewer(latest, current)) return "";
  return (
    `\n  ${amber("▸")} laneyard ${bold(latest)} is available ${dim(`(you have ${current})`)}\n` +
    `    ${bold("npm install -g laneyard")}\n`
  );
}

/**
 * The little colour this command needs, and no library to provide it.
 *
 * The palette is the product's own: green for what is settled, amber for what
 * wants attention, dim for what is context. Nothing here is decorative — a
 * colour that means nothing trains people to stop reading colours.
 */

/**
 * Colour is dropped when the output is not a terminal, or when `NO_COLOR` is
 * set. Escape codes in a piped log or a CI transcript are noise at best, and at
 * worst they end up quoted into a bug report.
 */
const enabled = (): boolean =>
  process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true;

const wrap = (code: string) => (text: string): string =>
  enabled() ? `[${code}m${text}[0m` : text;

export const bold = wrap("1");
export const dim = wrap("2");
export const green = wrap("32");
export const amber = wrap("33");
export const red = wrap("31");

/** A heading: bold, with a blank line above it so sections breathe. */
export const heading = (text: string): string => `\n${bold(text)}\n`;

/** `✓`, `▸`, `✗` in the same meanings they carry in the interface. */
export const ok = (text: string): string => `${green("✓")} ${text}`;
export const warn = (text: string): string => `${amber("▸")} ${text}`;
export const bad = (text: string): string => `${red("✗")} ${text}`;

/**
 * A `key   value` line, aligned so a block of them reads as a column.
 * The width is fixed rather than computed: these labels are known and short,
 * and a column that shifts between runs is harder to scan than a wide one.
 */
export const field = (label: string, value: string): string =>
  `  ${dim(label.padEnd(13))}${value}`;

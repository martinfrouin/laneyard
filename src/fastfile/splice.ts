/** One range of the source, and what replaces it. Offsets are in bytes. */
export interface Edit {
  start: number;
  length: number;
  replacement: string;
}

/**
 * Replaces ranges of a source, leaving every other byte exactly as it was.
 *
 * The same requirement `fastfile/store.ts` documents: a file written by hand
 * must never come back reformatted, reordered, or with its trailing newline
 * fixed. Someone may have spent a long time on that file.
 *
 * **Byte offsets, not string indices.** Prism reports positions in bytes, and
 * one accented character above the literal would put every later offset off by
 * one — a patch landing in the middle of a string, on a build file, silently.
 * So the work happens on a Buffer.
 *
 * Edits are applied last-first so an earlier replacement cannot shift the
 * offsets of the ones after it, and may be handed in in any order. Overlapping
 * edits throw: two rules that both claim the same bytes is a bug in the rule
 * table, and applying one of them arbitrarily would hide it.
 */
export function splice(source: string, edits: Edit[]): string {
  if (edits.length === 0) return source;

  const ordered = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    if (previous.start + previous.length > ordered[i]!.start) {
      throw new Error("edits overlap");
    }
  }

  let buffer = Buffer.from(source, "utf8");
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const edit = ordered[i]!;
    buffer = Buffer.concat([
      buffer.subarray(0, edit.start),
      Buffer.from(edit.replacement, "utf8"),
      buffer.subarray(edit.start + edit.length),
    ]);
  }
  return buffer.toString("utf8");
}

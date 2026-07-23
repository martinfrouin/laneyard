import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fieldsOf } from "../credentials/kinds.js";
import { appRootOf } from "../heuristics/platforms.js";
import { proposalsFor } from "../fastfile/adoption.js";
import type { Proposal } from "../fastfile/adoption.js";
import { splice } from "../fastfile/splice.js";
import type { Edit } from "../fastfile/splice.js";
import { scanFastfile } from "../sidecar/scan.js";
import type { Vault } from "../secrets/vault.js";
import { bold, dim, heading, ok, warn } from "./style.js";
import type { Asker } from "./prompt.js";

const exec = promisify(execFile);

export interface AdoptionOptions {
  cwd: string;
  /** Relative to the repository root, as everything in setup is. */
  fastlaneDir: string;
  slug: string;
  vault: Vault;
  asker: Asker;
  /** Test seam: lets a test force an edit that breaks the file. */
  editFor?: (proposal: Proposal) => Edit;
}

export interface AdoptionResult {
  /** How many proposals were accepted and written. */
  applied: number;
}

/**
 * Setup's second act: what to do about credentials the Fastfile names outright.
 *
 * **It runs after the project is already set up, and that ordering is the
 * whole guarantee.** Declining everything here must leave exactly the project
 * setup produced before this feature existed — so the act is separate rather
 * than folded into setup's final confirmation, and "refusing works" is true by
 * construction instead of by promise.
 *
 * Nothing it can do is required. No Ruby with Prism, no Fastfile, an
 * unparseable file, a literal naming a file that is not on disk: every one of
 * those means "nothing proposed", and setup carries on.
 */
export async function runAdoption(options: AdoptionOptions): Promise<AdoptionResult> {
  const { cwd, fastlaneDir, slug, vault, asker } = options;

  const literals = await scanFastfile(cwd, fastlaneDir);
  if (literals === null) {
    process.stdout.write(
      "\n" + dim("Fastfile not analysed — no Ruby with Prism available. Nothing else changes.\n"),
    );
    return { applied: 0 };
  }

  // A literal pointing at nothing is dropped rather than reported: there is no
  // file to lift into the vault, and patching to a variable nothing supplies
  // would trade one broken build for another.
  // Resolved once, here, so the prompt, the vault write and the git check all
  // speak about the same file rather than each resolving the path again.
  const found = new Map<Proposal, { bytes: Buffer; path: string }>();
  const proposals: Proposal[] = [];
  for (const proposal of proposalsFor(literals)) {
    if (proposal.tier === "file") {
      const hit = await readCredential(cwd, fastlaneDir, proposal);
      if (hit === null) continue;
      found.set(proposal, hit);
    }
    proposals.push(proposal);
  }
  if (proposals.length === 0) return { applied: 0 };

  process.stdout.write(heading("I read your Fastfile"));

  const accepted: Proposal[] = [];
  for (const proposal of proposals) {
    process.stdout.write(describe(fastlaneDir, proposal) + "\n");
    if (!(await asker.confirm(`  Store it here and use ${bold(proposal.varName)}?`, proposal.checked))) {
      continue;
    }
    accepted.push(proposal.tier === "secret" ? await named(asker, proposal) : proposal);
  }
  if (accepted.length === 0) {
    process.stdout.write(dim("\nNothing written. Your Fastfile is as it was.\n"));
    return { applied: 0 };
  }

  // The vault first, always. If lifting a credential fails, no Fastfile has
  // been patched to read a variable that nothing supplies.
  for (const proposal of accepted) await store(vault, slug, asker, proposal, found.get(proposal));

  const path = join(cwd, fastlaneDir, "Fastfile");
  const previous = await readFile(path, "utf8");
  const edits = accepted.flatMap((p) => (options.editFor ? [options.editFor(p)] : p.edits));
  await writeFile(path, splice(previous, edits), "utf8");

  // Verified with Prism rather than with fastlane: setup has no server to ask
  // for a lane list, and "does it still parse" is the question that matters.
  // Same contract as `FastfileStore.write` — the previous content goes back on
  // disk before this function returns, and no backup file is left behind.
  if ((await scanFastfile(cwd, fastlaneDir)) === null) {
    await writeFile(path, previous, "utf8");
    process.stdout.write(
      "\n" + warn("The patch stopped the Fastfile parsing. It has been put back as it was.\n"),
    );
    return { applied: 0 };
  }

  await report(cwd, fastlaneDir, accepted, found);
  return { applied: accepted.length };
}

/**
 * The bytes behind a `file` proposal, or null when the path names nothing.
 *
 * **A relative path in a Fastfile has no single meaning.** `"./play.json"`
 * resolves against whatever directory fastlane was invoked from, which is
 * usually the app root — the fastlane folder's parent — but a project that runs
 * fastlane from the repository root, or writes paths relative to the fastlane
 * folder itself, is equally ordinary. Nothing in the file says which.
 *
 * So all three are tried, nearest first. This costs nothing to be wrong about:
 * the patch replaces the literal with `ENV.fetch` either way, and the only
 * thing the path is needed for is finding bytes to put in the vault. Failing to
 * find them means no proposal, which is the safe answer.
 */
async function readCredential(
  cwd: string,
  fastlaneDir: string,
  proposal: Proposal,
): Promise<{ bytes: Buffer; path: string } | null> {
  const value = proposal.literal.value;

  const candidates = isAbsolute(value)
    ? [value]
    : [
        resolve(cwd, appRootOf(fastlaneDir), value),
        resolve(cwd, fastlaneDir, value),
        resolve(cwd, value),
      ];

  for (const path of candidates) {
    const bytes = await readFile(path).catch(() => null);
    if (bytes !== null) return { bytes, path };
  }
  return null;
}

/** One proposal, as three lines: where, what, and why it will not survive. */
function describe(fastlaneDir: string, proposal: Proposal): string {
  const { literal } = proposal;
  // A path is shown; a secret is not. Tier 3 is a value someone called a token
  // or a password, and setup's output is pasted into bug reports and kept in CI
  // transcripts — printing it there would be this feature leaking the very
  // thing it exists to put away. The file and line above say where to look.
  const shown =
    proposal.tier === "file"
      ? `"${literal.value}"`
      : proposal.tier === "inline"
        ? dim("(a key, inline in the file)")
        : dim("(a literal value, masked)");
  const why =
    proposal.tier === "inline"
      ? "This key is in your repository in cleartext."
      : proposal.tier === "file"
        ? "That path does not survive the clone: Laneyard builds from your remote."
        : "A literal secret in a build file is a secret in your history.";

  return (
    "\n" +
    `  ${bold(`${fastlaneDir}/Fastfile:${literal.line}`)}   ${literal.action}(${literal.arg}:)\n` +
    `                        → ${shown}\n` +
    dim(`  ${why}\n`)
  );
}

/**
 * A tier-3 proposal carrying the variable name the user actually wants.
 *
 * This is the one tier whose name is a guess. Tiers 1 and 2 take theirs from
 * `credentials/kinds.ts`, which holds the names fastlane itself reads; a
 * literal secret has no such table, so the name is assembled from the action
 * and the argument — `PILOT_API_TOKEN` — and a project that already calls that
 * variable something else would end up with the vault holding one name and the
 * patched Fastfile reading another. Nothing would report it: the run would
 * simply meet an absent variable.
 *
 * The replacement is rebuilt from the answer rather than patched afterwards,
 * so the name stored and the name read cannot drift apart.
 */
async function named(asker: Asker, proposal: Proposal): Promise<Proposal> {
  const varName = await asker.ask("  variable name", proposal.varName);
  return {
    ...proposal,
    varName,
    edits: [{ ...proposal.edits[0]!, replacement: `ENV.fetch("${varName}")` }],
  };
}

/** Lifts one accepted proposal into the vault. */
async function store(
  vault: Vault,
  slug: string,
  asker: Asker,
  proposal: Proposal,
  found: { bytes: Buffer; path: string } | undefined,
): Promise<void> {
  if (proposal.kind === undefined) {
    await vault.set(slug, proposal.varName, proposal.literal.value, true);
    return;
  }

  const bytes =
    proposal.tier === "inline" ? Buffer.from(proposal.literal.value, "utf8") : found!.bytes;
  // The original name is kept: some tools read meaning from it, and
  // `materialise.ts` already relies on `AuthKey_<KEY ID>.p8` surviving intact.
  const fileName =
    proposal.tier === "inline" ? `${proposal.kind}.key` : basename(found!.path);

  // The fields the file cannot carry. `fieldsOf` is the same table the web
  // upload form reads, so the CLI cannot end up asking for a different set.
  const fields: Record<string, string> = {};
  for (const field of fieldsOf(proposal.kind)) {
    if (field.optional) continue;
    const suggested = proposal.suggestedFields[field.name] ?? field.suggested ?? "";
    fields[field.name] = await asker.ask(`  ${field.label}`, suggested);
  }

  await vault.setCredential(slug, proposal.kind, { fileName, fileBytes: bytes, fields, varNames: {} });
}

/** What is left for the user to do, including the part Laneyard will not do. */
async function report(
  cwd: string,
  fastlaneDir: string,
  accepted: Proposal[],
  found: Map<Proposal, { bytes: Buffer; path: string }>,
): Promise<void> {
  process.stdout.write(
    "\n" +
      ok(`Stored ${accepted.length} credential${accepted.length > 1 ? "s" : ""} in this machine's vault.\n`) +
      ok(`Patched ${fastlaneDir}/Fastfile.\n`) +
      "\n" +
      // Said plainly because it is the trap `addProjectToConfig` already
      // documents: Laneyard builds from a clone of the remote, so nothing in
      // the working copy reaches a run until it is pushed.
      warn("Commit and push it, or your runs still read the old file.\n") +
      dim("  git diff -- " + join(fastlaneDir, "Fastfile") + "\n"),
  );

  // Said, never done. Removing a file from someone's repository is not
  // setup's to decide, and `git rm --cached` does not take it out of the
  // history anyway — so the honest thing is to name it.
  const tracked = await trackedCredentials(cwd, accepted, found);
  if (tracked.length > 0) {
    process.stdout.write(
      "\n" +
        warn(`${tracked.join(", ")} ${tracked.length > 1 ? "are" : "is"} tracked by git.\n`) +
        dim("  The patch does not take it out of your history. Rotating the key does.\n"),
    );
  }
}

/**
 * Which of the accepted credentials git already has. Silent when git cannot
 * answer — the same courtesy `fastlaneDirIsTracked` extends.
 *
 * Asked about the *resolved* paths, not the literals: `"./play.json"` written
 * in a Fastfile one directory down is not a path `git ls-files` can answer
 * about from the repository root.
 */
async function trackedCredentials(
  cwd: string,
  accepted: Proposal[],
  found: Map<Proposal, { bytes: Buffer; path: string }>,
): Promise<string[]> {
  const paths = accepted.flatMap((p) => {
    const hit = found.get(p);
    return hit ? [hit.path] : [];
  });
  if (paths.length === 0) return [];
  try {
    const { stdout } = await exec("git", ["ls-files", "--", ...paths], { cwd });
    return stdout.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { glob } from "tinyglobby";
import { Workspace } from "../../git/workspace.js";
import { NO_APPFILE, parseAppfile } from "../../heuristics/appfile.js";
import { findAndroidBuild } from "../../heuristics/android-root.js";
import type { AndroidBuild } from "../../heuristics/android-root.js";
import type { PropertiesFile, SigningFacts } from "../../heuristics/android-signing.js";
import { exportedVarNames } from "../../credentials/kinds.js";
import { envExampleNames } from "../required-secrets.js";
import type { AppfileFacts } from "../../heuristics/appfile.js";
import { appRootOf, resolvePlatforms, searchDir } from "../../heuristics/platforms.js";
import type { FindPaths, Platform } from "../../heuristics/platforms.js";
import { runChecklist } from "../../heuristics/readiness.js";
import type { KeystoreSetting, Known, LaneUses, Unread } from "../../heuristics/readiness.js";
import { LANEYARD_MARKER, propertyNames } from "../../runner/gradle-properties.js";
import type { Vault } from "../../secrets/vault.js";
import type { AppContext } from "../app.js";

const exec = promisify(execFile);

/**
 * `bundle check` in the workspace, rejecting with what bundler said.
 *
 * Installs nothing: the checklist reports, it does not act. The timeout is
 * generous because bundler resolves the whole Gemfile.lock, and short enough
 * that a wedged bundler does not hold the request open.
 */
async function bundleCheck(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("bundle", ["check"], { cwd, timeout: 60_000 });
    return stdout.trim();
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string; message: string };
    throw new Error((err.stdout || err.stderr || err.message).trim());
  }
}

/** The path of a `fastlane` a run would find, or null. */
async function findFastlane(): Promise<string | null> {
  try {
    const { stdout } = await exec("which", ["fastlane"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    // A non-zero exit from `which` is the answer "no", not a failure.
    return null;
  }
}

/** The globbing `heuristics/platforms.ts` asks for, bound to a directory. */
const findIn =
  (dir: string): FindPaths =>
  (globs, { onlyDirectories }) =>
    glob(globs, onlyDirectories ? { cwd: dir, onlyDirectories: true } : { cwd: dir, onlyFiles: true });

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Is this the user's own properties file — as opposed to one Laneyard wrote
 * and failed to clean up?
 *
 * `gradle-properties.ts` marks every file it writes with `LANEYARD_MARKER` as
 * its first line, precisely so this check can tell the two apart. A run killed
 * between writing the file and reaching its `finally` leaves a marked one
 * behind in the persistent clone; counting it as the user's own signing
 * configuration would flip the checklist from "the release build will use the
 * debug key" to "the release key is used" — a green verdict Laneyard
 * manufactured for itself out of a cleanup it failed to run.
 *
 * Reading fails the same way `exists` does: a missing file, a permission
 * error, or one this process cannot open are all "not the user's file",
 * because none of them is evidence of a real signing configuration.
 */
async function isUsersOwn(path: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return false;
  return (text.split("\n")[0] ?? "").trimEnd() !== LANEYARD_MARKER;
}

/**
 * Is the properties file where the build script would look for it — and is it
 * the user's, not Laneyard's own leftover?
 *
 * The module directory is the one holding the build script, and the Gradle root
 * is its parent — `android/` for an `android/app/build.gradle`. Which of the two
 * the name is relative to is the script's decision, and the parser reports which
 * one it made. When it could not tell, both are looked in: answering "not in the
 * clone" because the wrong directory was searched would have the checklist
 * inventing the very failure it exists to catch. Both places apply the same
 * marker rule — a leftover in either one is still Laneyard's, not the user's.
 */
async function isPresent(build: AndroidBuild, file: PropertiesFile): Promise<boolean> {
  const { moduleDir, gradleRoot } = build;
  const places =
    file.scope === "root"
      ? [gradleRoot]
      : file.scope === "module"
        ? [moduleDir]
        : [gradleRoot, moduleDir];

  const found = await Promise.all(places.map((dir) => isUsersOwn(join(dir, file.name))));
  return found.some(Boolean);
}

/**
 * What the android build script says about release signing, and whether the
 * file it depends on is in the clone.
 *
 * The listing is the caller's half of the answer, as everywhere else here: the
 * check reads text and reaches for nothing. Which script speaks for the android
 * side is `heuristics/android-root.ts`'s decision rather than this file's,
 * because the runner writes the properties file against that same decision — see
 * that module for why the two must not be able to disagree.
 */
async function androidSigning(
  workspacePath: string,
  appRoot: string,
  unreachable: string | null,
): Promise<{
  androidSigning: Known<SigningFacts>;
  signingFilePresent: boolean;
  signingFileAt: string | null;
}> {
  if (unreachable !== null) {
    return { androidSigning: { ok: false, reason: unreachable }, signingFilePresent: false, signingFileAt: null };
  }

  const build = await findAndroidBuild(join(workspacePath, appRoot));
  if (build === null) {
    return {
      androidSigning: { ok: false, reason: "no android build.gradle found in the clone" },
      signingFilePresent: false,
      signingFileAt: null,
    };
  }

  const present =
    build.facts.conditionalOn === null ? false : await isPresent(build, build.facts.conditionalOn);

  return {
    androidSigning: { ok: true, value: build.facts },
    signingFilePresent: present,
    signingFileAt: propertiesFileAt(build, join(workspacePath, appRoot)),
  };
}

/**
 * Where the build reads the properties file, relative to the app.
 *
 * The scope resolved into a path someone can paste into the block's form, and
 * the same resolution `runner/gradle-properties.ts` makes — `root` is the Gradle
 * root, `module` the app module. `unknown` stays null: that is the case the
 * configured path exists to settle, and inventing a likely answer for it would
 * put a file in the wrong directory with nothing to say it was a guess.
 */
function propertiesFileAt(build: AndroidBuild, appRoot: string): string | null {
  const on = build.facts.conditionalOn;
  if (on === null) return null;
  const dir = on.scope === "root" ? build.gradleRoot : on.scope === "module" ? build.moduleDir : null;
  if (dir === null) return null;
  const inside = relative(appRoot, join(dir, on.name));
  // A build outside the app root is a shape nothing here can name relative to
  // it, and a `../` in this field would be refused by the runner anyway.
  return inside.startsWith("..") || isAbsolute(inside) ? null : inside;
}

/**
 * What the keystore block says about the properties file, and nothing else.
 *
 * The block has to be decrypted to be asked — `property_names` and
 * `properties_path` are stored with the passphrases — so the narrowing happens
 * here, at the last point that touches plaintext. What crosses into the
 * checklist is two settings a browser is already shown on the block's own form.
 *
 * A block that will not decrypt is not an error page: it is a keystore the
 * checklist cannot speak for, and `credentials` already reports that separately.
 */
function keystoreSetting(vault: Vault, slug: string): KeystoreSetting | null {
  try {
    const block = vault.resolveCredential(slug, "android_keystore");
    if (!block) return null;
    const path = (block.fields["properties_path"] ?? "").trim();
    return { propertyNames: propertyNames(block.fields), propertiesPath: path === "" ? null : path };
  } catch {
    return null;
  }
}

export async function registerReadinessRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * Where this project's build reads its signing properties file.
   *
   * One fact, read from the clone, and the whole of what the keystore block's
   * form cannot ask for itself: the field is a path relative to the app, and
   * nobody types one of those correctly from a build script they are not looking
   * at. Pre-filled with this, a wrong value is visible as a value that differs.
   *
   * Cheap enough to answer on opening a screen — two files parsed, no git, no
   * bundler — which is why it is not part of the readiness answer even though
   * that computes it too. Null for a project with no android build, or one whose
   * script names the file in a way the parser cannot resolve to a directory.
   */
  app.get("/api/projects/:slug/signing-hints", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });

    const workspacePath = ctx.workspacePath(slug);
    const resolved = await ctx.config.resolve(slug, workspacePath).catch(() => null);
    const appRoot = appRootOf(resolved?.settings.fastlane_dir ?? "fastlane");

    // The clone as it stands, never fetched for this: a screen opening must not
    // pull a repository, and a project never cloned simply has no hint to give.
    const build = await findAndroidBuild(searchDir(workspacePath, appRoot)).catch(() => null);
    return { propertiesPath: build === null ? null : propertiesFileAt(build, searchDir(workspacePath, appRoot)) };
  });

  /**
   * Computed only when asked for.
   *
   * These checks shell out to git and to bundler, so nothing else in the
   * interface may trigger them: the tab asks when it is opened, and when the
   * user presses refresh. Nothing here is cached either — a stale green tick is
   * worse than a red cross, which is why the answer carries the time it was
   * produced.
   */
  app.get("/api/projects/:slug/readiness", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const entry = ctx.config.project(slug);
    if (!entry) return reply.code(404).send({ error: "Unknown project" });

    const workspacePath = ctx.workspacePath(slug);
    const workspace = new Workspace(workspacePath, entry.git_url, entry.git_auth);

    // What each lane calls lives in the repository, so the clone has to exist.
    // A clone that fails is not an error page: it is the reason two of the five
    // checks cannot answer, and the other three still can.
    let unreachable: string | null = null;
    try {
      await ctx.ensureWorkspace(slug);
    } catch (cause) {
      unreachable = (cause as Error).message;
    }

    const resolved = await ctx.config.resolve(slug, workspacePath);
    const fastlaneDir = resolved?.settings.fastlane_dir ?? "fastlane";

    const read =
      unreachable !== null
        ? { ok: false as const, reason: unreachable }
        : await ctx
            .uses(slug, workspacePath, fastlaneDir)
            .then((value) => ({ ok: true as const, value }))
            // Broken Fastfile, no Ruby, no fastlane: all of them are "could not
            // tell", none of them is a 500.
            .catch((cause: unknown) => ({ ok: false as const, reason: (cause as Error).message }));

    const uses: Known<LaneUses[]> = read.ok
      ? { ok: true, value: read.value.lanes }
      : { ok: false, reason: read.reason };

    // What reading the Fastfile could not account for. `fastlane/actions` is the
    // caller's half of the answer — a directory listing, not something the Ruby
    // parser could know — and the sidecar supplies the other, `import`. A check
    // that would conclude something from finding nothing consults this first.
    const unread: Known<Unread> = read.ok
      ? {
          ok: true,
          value: {
            imports: read.value.imports,
            customActions: await exists(join(workspacePath, fastlaneDir, "actions")),
          },
        }
      : { ok: false, reason: read.reason };

    // What the project builds for decides which half of the checklist applies.
    // `laneyard.yml` answers on its own; without it the workspace is looked at,
    // and an unreachable workspace is a "could not tell" rather than a claim
    // that the repository holds neither an Xcode project nor a Gradle build.
    const configured = resolved?.settings.platforms;
    const platforms: Known<Platform[]> =
      unreachable !== null && (configured === undefined || configured.length === 0)
        ? { ok: false, reason: unreachable }
        : {
            ok: true,
            // Beside the Fastfile rather than at the repository root: in a
            // monorepo the app is one directory down, and so are its platform
            // folders.
            value: await resolvePlatforms(
              configured,
              findIn(searchDir(workspacePath, appRootOf(fastlaneDir))),
            ),
          };

    // The Appfile is fastlane's own file, beside the Fastfile, and it is where a
    // project configured long before it met Laneyard keeps its Play Store
    // service account. An absent one is a fact — `NO_APPFILE` — not a failure;
    // an unreachable workspace is the only reason this cannot be answered.
    const appfile: Known<AppfileFacts> =
      unreachable !== null
        ? { ok: false, reason: unreachable }
        : await readFile(join(workspacePath, fastlaneDir, "Appfile"), "utf8").then(
            (text) => ({ ok: true as const, value: parseAppfile(text) }),
            // Missing, unreadable, a directory: all of them mean the same to a
            // check, which is that the Appfile says nothing.
            () => ({ ok: true as const, value: NO_APPFILE }),
          );

    // Listed the same way platforms are, from the clone rather than from any
    // path a Fastfile mentions: what is asked is "does the repository carry a
    // key", which is a question about the repository.
    const keyFilesInRepo: Known<string[]> =
      unreachable !== null
        ? { ok: false, reason: unreachable }
        : await glob(["**/*.p8"], { cwd: workspacePath, onlyFiles: true, dot: true }).then(
            (found) => ({ ok: true as const, value: found.sort() }),
            (cause: unknown) => ({ ok: false as const, reason: (cause as Error).message }),
          );

    const sections = await runChecklist({
      probeRepository: () => workspace.probeRemote(),
      dependencies: {
        workspace:
          unreachable !== null
            ? { ok: false, reason: unreachable }
            : { ok: true, value: { hasGemfile: await exists(join(workspacePath, "Gemfile")) } },
        bundleCheck: () => bundleCheck(workspacePath),
        findFastlane,
      },
      // Names only: the vault never hands a value to anything but a run.
      secretKeys: ctx.vault.list(slug).map((s) => s.key),
      // Which blocks this project holds, read the way a run reads them, so the
      // checklist and the run cannot disagree about whether a credential exists.
      blocks: ctx.vault.listCredentials(slug).map((c) => c.kind),
      // And the names those blocks will export, which the environment check
      // counts as supplied — Laneyard writes the file and sets the variable
      // itself, so a lane reading it is not a lane short of anything. The same
      // list the secrets screen is given, from the same call.
      blockNames: exportedVarNames(ctx.vault.listCredentials(slug)),
      keystore: keystoreSetting(ctx.vault, slug),
      uses,
      platforms,
      appfile,
      keyFilesInRepo,
      unread,
      // A run inherits the server's environment, so a variable exported where
      // Laneyard was started really is available to a lane. Names only: a
      // checklist has no business reading a value, here least of all.
      serverEnv: Object.keys(process.env),
      ...(await androidSigning(workspacePath, appRootOf(fastlaneDir), unreachable)),
      declaredSecrets: [
        ...(resolved?.settings.required_secrets ?? []),
        ...(await envExampleNames(workspacePath, fastlaneDir)),
      ],
    });

    return { checkedAt: new Date().toISOString(), sections };
  });
}

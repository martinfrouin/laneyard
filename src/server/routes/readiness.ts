import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { glob } from "tinyglobby";
import { Workspace } from "../../git/workspace.js";
import { NO_APPFILE, parseAppfile } from "../../heuristics/appfile.js";
import { parseAndroidSigning } from "../../heuristics/android-signing.js";
import type { PropertiesFile, SigningFacts } from "../../heuristics/android-signing.js";
import { envExampleNames } from "../required-secrets.js";
import type { AppfileFacts } from "../../heuristics/appfile.js";
import { appRootOf, resolvePlatforms, searchDir } from "../../heuristics/platforms.js";
import type { FindPaths, Platform } from "../../heuristics/platforms.js";
import { runChecklist } from "../../heuristics/readiness.js";
import type { Known, LaneUses, Unread } from "../../heuristics/readiness.js";
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
 * Is the properties file where the build script would look for it?
 *
 * The module directory is the one holding the build script, and the Gradle root
 * is its parent — `android/` for an `android/app/build.gradle`. Which of the two
 * the name is relative to is the script's decision, and the parser reports which
 * one it made. When it could not tell, both are looked in: answering "not in the
 * clone" because the wrong directory was searched would have the checklist
 * inventing the very failure it exists to catch.
 */
async function isPresent(scriptPath: string, file: PropertiesFile): Promise<boolean> {
  const moduleDir = dirname(scriptPath);
  const gradleRoot = dirname(moduleDir);
  const places =
    file.scope === "root"
      ? [gradleRoot]
      : file.scope === "module"
        ? [moduleDir]
        : [gradleRoot, moduleDir];

  const found = await Promise.all(places.map((dir) => exists(join(dir, file.name))));
  return found.some(Boolean);
}

/**
 * What the android build script says about release signing, and whether the
 * file it depends on is in the clone.
 *
 * The listing is the caller's half of the answer, as everywhere else here: the
 * check reads text and reaches for nothing. Both conventional locations are
 * tried — `android/app/` for a Flutter or React Native project, and `app/` for a
 * repository that is an Android project outright.
 */
async function androidSigning(
  workspacePath: string,
  appRoot: string,
  unreachable: string | null,
): Promise<{ androidSigning: Known<SigningFacts>; signingFilePresent: boolean }> {
  if (unreachable !== null) {
    return { androidSigning: { ok: false, reason: unreachable }, signingFilePresent: false };
  }

  const root = join(workspacePath, appRoot);
  for (const candidate of ["android/app/build.gradle.kts", "android/app/build.gradle", "app/build.gradle.kts", "app/build.gradle"]) {
    const text = await readFile(join(root, candidate), "utf8").catch(() => null);
    if (text === null) continue;

    const facts = parseAndroidSigning(text);
    const present =
      facts.conditionalOn === null
        ? false
        : await isPresent(join(root, candidate), facts.conditionalOn);

    return { androidSigning: { ok: true, value: facts }, signingFilePresent: present };
  }

  return {
    androidSigning: { ok: false, reason: "no android build.gradle found in the clone" },
    signingFilePresent: false,
  };
}

export async function registerReadinessRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
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

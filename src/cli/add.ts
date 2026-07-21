import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Document, parseDocument, YAMLSeq } from "yaml";
import { hashPassword } from "../server/auth.js";
import { detectProject } from "./detect.js";

export interface NewProjectEntry {
  slug: string;
  name: string;
  git_url: string;
  default_branch: string;
  fastlane_dir: string;
  runtime: "bundle" | "system";
  artifact_globs: string[];
}

/**
 * Ajoute un bloc projet à config.yml en préservant le reste du fichier.
 *
 * L'édition passe par le document YAML plutôt que par un aller-retour
 * parse/serialize : les commentaires de l'utilisateur — et l'ordre de ses clés —
 * survivent. C'est la même exigence que pour le Fastfile : un fichier écrit à la
 * main ne doit jamais ressortir abîmé.
 */
export async function addProjectToConfig(path: string, entry: NewProjectEntry): Promise<void> {
  let doc: Document.Parsed | Document;
  try {
    doc = parseDocument(await readFile(path, "utf8"));
  } catch {
    doc = new Document({});
  }
  if (doc.contents === null) doc = new Document({});

  if (!doc.hasIn(["server", "password_hash"])) {
    // Un serveur sans mot de passe refuserait toute connexion : on en génère un
    // et on l'affiche une seule fois, à l'appelant de le noter.
    const generated = randomBytes(9).toString("base64url");
    doc.setIn(["server", "password_hash"], hashPassword(generated));
    process.stdout.write(`\nMot de passe généré : ${generated}\n  (notez-le, il ne sera plus affiché)\n`);
  }

  const projects = doc.getIn(["projects"]);
  const seq = projects instanceof YAMLSeq ? projects : new YAMLSeq();
  if (!(projects instanceof YAMLSeq)) doc.setIn(["projects"], seq);

  for (const item of seq.items) {
    const slug = (item as { get?: (k: string) => unknown }).get?.("slug");
    if (slug === entry.slug) {
      throw new Error(`Un projet porte déjà le slug « ${entry.slug} » dans ${path}`);
    }
  }

  seq.add(doc.createNode(entry));
  await writeFile(path, doc.toString(), "utf8");
}

/** Point d'entrée de `laneyard add`. */
export async function runAddCommand(cwd: string, configPath: string, slugOverride?: string): Promise<number> {
  const d = await detectProject(cwd);

  if (d.fastlaneDir === null) {
    process.stderr.write(
      "Aucun Fastfile trouvé ici. Laneyard pilote fastlane : lancez la commande depuis un projet " +
        "qui l'utilise déjà, ou exécutez d'abord `fastlane init`.\n",
    );
    return 1;
  }
  if (d.gitUrl === null) {
    process.stderr.write(
      "Aucun distant git nommé « origin ». Laneyard clone les projets depuis leur dépôt : " +
        "ajoutez un distant, ou renseignez git_url à la main dans config.yml.\n",
    );
    return 1;
  }

  const slug = slugOverride ?? d.slug;
  await addProjectToConfig(configPath, {
    slug,
    name: slug,
    git_url: d.gitUrl,
    default_branch: d.defaultBranch,
    fastlane_dir: d.fastlaneDir,
    runtime: d.runtime,
    artifact_globs: d.artifactGlobs,
  });

  process.stdout.write(
    `\nProjet « ${slug} » ajouté à ${configPath}\n` +
      `  dépôt        ${d.gitUrl} (${d.defaultBranch})\n` +
      `  fastlane     ${d.fastlaneDir}\n` +
      `  exécution    ${d.runtime}\n` +
      `  artefacts    ${d.artifactGlobs.join(", ") || "aucun motif détecté — à compléter"}\n` +
      `\nRelancez Laneyard ou attendez le rechargement automatique, le projet apparaîtra dans l'interface.\n`,
  );
  return 0;
}

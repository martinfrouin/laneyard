#!/usr/bin/env node
// npm dépose parfois le spawn-helper de node-pty sans droit d'exécution, ce qui
// fait échouer tout lancement de processus avec un message opaque. On répare au
// lieu de laisser chacun le découvrir.
import { chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const root = "node_modules/node-pty/prebuilds";

try {
  for (const dir of await readdir(root)) {
    const helper = join(root, dir, "spawn-helper");
    try {
      const info = await stat(helper);
      // 0o111 : au moins un bit d'exécution.
      if ((info.mode & 0o111) === 0) {
        await chmod(helper, 0o755);
        console.log(`node-pty : droit d'exécution rendu à ${helper}`);
      }
    } catch {
      // Pas de helper dans ce dossier : rien à faire.
    }
  }
} catch {
  // node-pty absent ou sans prebuilds : l'installation n'a pas à échouer pour autant.
}

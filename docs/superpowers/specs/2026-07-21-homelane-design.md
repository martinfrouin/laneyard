# Homelane — conception

**Date** : 2026-07-21
**État** : validé, prêt pour la planification d'implémentation

## Le problème

Déclencher, suivre et modifier des builds mobiles impose aujourd'hui de passer soit par un
terminal sur la machine de dev, soit par un service hébergé type Bitrise — facturé, opaque et
propriétaire de la chaîne de signature.

Homelane est un serveur de build auto-hébergé bâti sur fastlane. Il tourne sur une machine que
tu possèdes, expose une interface web sur ton réseau local, et te permet de lancer des lanes,
d'en suivre l'exécution en direct et de modifier le Fastfile sans ouvrir d'éditeur.

## Périmètre

**Dans la v1**

- Plusieurs projets enregistrés, chacun cloné depuis son dépôt git.
- Déclenchement manuel d'une lane depuis l'interface, avec ses paramètres.
- Suivi en direct : logs diffusés, chronologie des actions, statut, durée.
- Historique des runs avec artefacts téléchargeables.
- Édition du Fastfile : vue structurée par actions et éditeur texte, puis commit et push.
- Coffre de secrets injectés en variables d'environnement.
- Notifications de fin de run.
- Écran « Préparation CI » : check-list d'autonomie par projet.

**Hors v1, mais la conception ne doit pas les rendre impossibles**

- Déclencheurs git (scrutation de branches, webhooks) — la colonne `trigger` existe déjà.
- Runs planifiés.
- Plusieurs machines d'exécution.

**Explicitement hors périmètre**

- Multi-utilisateur, rôles, permissions. Un outil personnel, un mot de passe.
- Hébergement cloud, exposition sur Internet.
- Support d'autres outils que fastlane.

## Contraintes

- Tourne sur macOS **et** Linux — un projet Android n'a aucune raison d'exiger un Mac.
- Cible : une machine dédiée qui reste allumée, pilotée depuis un navigateur sur le réseau local.
- Aucune connaissance de fastlane codée en dur. Ni noms d'actions, ni paramètres, ni lanes.
- Un secret ne doit jamais atterrir dans un fichier de log.
- Le Fastfile de l'utilisateur ne doit jamais ressortir abîmé d'une édition.

## Architecture

```
Navigateur (machine de travail)
        │  HTTP + WebSocket sur le LAN, cookie de session
        ▼
┌─────────────────────────────────────────────────────┐
│ Machine hôte — launchd (macOS) ou systemd (Linux)   │
│                                                      │
│  Serveur Fastify + WebSocket                        │
│      │                    │                          │
│      ▼                    ▼                          │
│  Runner              Sidecar Ruby                    │
│  (node-pty,          (bundle exec ruby               │
│   file d'attente)     introspect.rb)                 │
│      │                    ┆                          │
│      ▼                    ┆                          │
│  SQLite · workspaces git · logs · artefacts          │
└──────┼────────────────────┼──────────────────────────┘
       ▼ PTY                ┆ API Ruby
    fastlane — celui du Gemfile du projet
```

### Choix : Node/TypeScript avec un sidecar Ruby

Le backend est en TypeScript (Fastify). Toute connaissance de fastlane provient d'un script Ruby
lancé **dans le bundle du projet concerné**.

Deux alternatives ont été écartées :

- **Backend tout-Ruby** — accès natif à l'API fastlane, mais Homelane deviendrait prisonnier d'un
  environnement Ruby précis, cohabiterait mal avec les Gemfile des projets, et l'écosystème
  temps-réel y est moins praticable.
- **Binaire Go/Rust parsant la sortie texte** — déploiement idéal, mais sans l'API Ruby les
  métadonnées d'actions sont perdues et l'éditeur structuré retomberait sur une liste codée en
  dur qui se périme à chaque version de fastlane. Rédhibitoire.

Le sidecar isole entièrement Homelane du Ruby de chaque projet tout en lui donnant accès à la
vraie version de fastlane et aux plugins installés.

### Composants

#### Serveur (`src/server`)

Unique porte d'entrée. REST pour les actions, WebSocket pour la diffusion des logs et la remontée
de saisie clavier vers le PTY. Un mot de passe haché en configuration, une session par cookie.
Écoute sur `0.0.0.0` par défaut.

#### Runner (`src/runner`)

Exécute les jobs. File d'attente avec **un run à la fois par projet** — deux builds ne peuvent pas
partager un workspace git — et une limite globale configurable, à 1 par défaut, parce qu'un build
Xcode monopolise la machine.

#### Sidecar Ruby (`ruby/introspect.rb`)

Le seul composant qui connaît fastlane. Trois commandes, sortie JSON, ne modifie jamais rien :

| Commande  | Sortie |
|-----------|--------|
| `lanes`   | Lanes du projet : nom, plateforme, description, paramètres attendus |
| `actions` | Toutes les actions disponibles avec leurs options typées (clé, type, description, défaut, variable d'environnement), plugins du projet inclus |
| `parse`   | Arbre syntaxique du Fastfile avec les positions en octets de chaque instruction |

L'API sous-jacente est vérifiée :

```ruby
require "fastlane"
Fastlane.load_actions
klass = Fastlane::Actions.action_class_ref("build_app")
klass.available_options.map { |o| { key: o.key, desc: o.description,
                                    type: o.data_type.to_s, optional: o.optional,
                                    env: o.env_name } }
```

L'analyse syntaxique utilise Prism, l'analyseur officiel de Ruby, pour obtenir les positions
exactes dans le fichier.

#### Front (`src/web`)

SPA React. Trois niveaux de navigation : projets → projet → run.

### Stockage

SQLite pour l'état. Fichiers sur disque pour les logs et les artefacts : un log de build pèse
plusieurs mégaoctets et n'a rien à faire en base.

```
~/.homelane/
  homelane.db
  key                    # clé de chiffrement des secrets, 0600
  config.json            # port, hash du mot de passe, limites
  workspaces/<projet>/   # clones git, conservés entre les runs
  logs/<run>.log
  artifacts/<run>/
```

## Modèle de données

### `project`

| Champ | Type | Rôle |
|---|---|---|
| `id`, `name`, `slug` | text | Identité, URL lisible |
| `git_url`, `default_branch` | text | Source du code |
| `git_auth` | text | Chemin d'une clé SSH, ou référence vers un secret (token HTTPS) |
| `fastlane_dir` | text | Sous-dossier contenant le Fastfile (défaut `fastlane`), gère les monorepos |
| `runtime` | text | `bundle` ou `system` : comment invoquer fastlane |
| `artifact_globs` | json | Motifs de collecte en plus des chemins annoncés par fastlane |
| `interactive_default` | bool | Autoriser les prompts par défaut sur ce projet |
| `color` | text | Repère visuel |

### `secret`

| Champ | Type | Rôle |
|---|---|---|
| `project_id` | id? | Portée : un projet, ou nul pour un secret global |
| `key` | text | Nom de la variable d'environnement |
| `value_enc` | blob | Chiffré au repos, AES-GCM, clé hors base |
| `masked` | bool | Si vrai : jamais réaffiché dans l'UI, caviardé dans les logs |

### `run`

| Champ | Type | Rôle |
|---|---|---|
| `project_id`, `lane`, `platform` | — | Ce qui a été lancé |
| `params` | json | Options passées à la lane |
| `status` | text | `queued` · `preparing` · `running` · `success` · `failed` · `cancelled` · `interrupted` |
| `branch`, `commit_sha` | text | État exact du code au moment du build |
| `trigger` | text | `manual` en v1 ; la colonne existe pour la suite |
| `interactive` | bool | Mode de ce run |
| `queued_at`, `started_at`, `finished_at` | ts | Attente et durée réelle, séparées |
| `exit_code`, `error_summary` | — | Cause d'échec extraite du log |

### `run_step`

| Champ | Type | Rôle |
|---|---|---|
| `run_id`, `idx`, `name` | — | Ordre et nom de l'action |
| `started_at`, `duration_ms`, `status` | — | Repérer l'étape lente ou fautive |
| `log_offset` | int | Position dans le log : cliquer une étape saute au bon endroit |

### `artifact`

| Champ | Type | Rôle |
|---|---|---|
| `run_id`, `filename`, `path`, `size` | — | Fichier déplacé hors du workspace |
| `kind` | text | `ipa` · `apk` · `aab` · `dsym` · `other` |

### Trois absences volontaires

- **Aucune table `lane`.** Les lanes vivent dans le Fastfile. Homelane les lit via le sidecar et
  met le résultat en cache, indexé par empreinte du fichier. L'interface ne peut pas afficher une
  lane qui n'existe plus.
- **Aucune table `user`.** Un mot de passe haché en configuration. Le multi-utilisateur n'a pas de
  sens pour un outil auto-hébergé personnel.
- **Aucun log en base.** Un fichier par run, diffusé en direct puis relu à la demande.

## Cycle de vie d'un run

1. **Déclenchement** → `queued`. Le formulaire de paramètres est généré depuis la signature réelle
   de la lane. Le run est créé en base immédiatement : même en attente, il est visible.
2. **File d'attente.** Un run par projet, limite globale configurable.
3. **Préparation** → `preparing`. `git fetch` puis `checkout` dans le workspace du projet,
   conservé entre les runs donc rapide, nettoyable sur demande. Le SHA est enregistré. Si le
   `Gemfile.lock` a changé, `bundle install` tourne d'abord. Les secrets sont déchiffrés en
   mémoire et préparés en variables d'environnement.
4. **Exécution** → `running`. fastlane est lancé dans un pseudo-terminal : il conserve ses
   couleurs et son affichage habituel. Chaque fragment de sortie part vers trois destinations —
   le fichier de log, les navigateurs connectés, un tampon pour les connexions tardives.
   En parallèle, les lignes d'étape alimentent `run_step`.
5. **Fin.** Le code de sortie décide. En cas d'échec, le résumé d'erreur est extrait du bloc
   d'erreur de fastlane. Les artefacts sont collectés depuis les chemins annoncés par fastlane et
   les motifs configurés, puis déplacés hors du workspace pour survivre au prochain build.
6. **Annulation.** `SIGINT` au groupe de processus — fastlane fait son ménage — puis `SIGKILL`
   s'il s'obstine. Délai maximum par run, 60 min par défaut.

### Mode non-interactif par défaut

Les runs tournent avec `CI=true`. Un run qui aurait besoin d'une saisie échoue immédiatement avec
un message actionnable, au lieu de rester figé sur un prompt invisible. Une case « mode
interactif » au lancement, et un réglage par projet, rouvrent les prompts pour les phases de mise
en place (première utilisation de `match`, découverte d'un device).

Le PTY est utilisé dans les deux cas : il donne la sortie colorée, l'affichage fastlane normal, et
une porte de sortie quand un run se bloque malgré tout.

L'écran **Préparation CI** est ce qui rend un projet autonome. Check-list recalculée à la demande,
avec un formulaire pour combler chaque manque :

- Dépôt accessible sans mot de passe.
- Dépendances installables.
- Authentification App Store Connect — une clé API supprime le 2FA, contrairement à une session
  Apple ID à renouveler.
- `match` en readonly avec `MATCH_PASSWORD` présent.
- Aucune action bloquante détectée dans les lanes.

### Caviardage des secrets

Les valeurs des secrets marqués `masked` sont remplacées dans le flux **avant** écriture disque et
avant diffusion WebSocket. Ce n'est pas un filtrage d'affichage : la valeur n'existe jamais dans un
fichier de log.

## L'éditeur hybride

### Ce que « structuré » veut dire

Le sidecar renvoie l'arbre syntaxique avec les positions exactes. Une instruction devient une carte
éditable **uniquement** si elle est un appel d'action fastlane connue dont tous les arguments sont
littéraux — symboles, chaînes, nombres, booléens, tableaux et tables de littéraux.

Tout le reste — conditions, boucles, variables, interpolations, blocs, méthodes maison — devient
une carte **non structurée** : affichée telle quelle, lisible, modifiable uniquement en mode texte.
Aucune tentative de deviner.

Les formulaires de paramètres sont générés depuis les métadonnées réelles de l'action. Les plugins
du projet sont donc pris en charge sans effort particulier.

### Garantie d'intégrité

- **Réécriture chirurgicale.** Modifier un paramètre ne réécrit que la plage d'octets de cette
  instruction. Le fichier n'est jamais régénéré depuis l'arbre — commentaires, indentation et Ruby
  biscornu survivent intacts.
- **Vérification après chaque écriture.** Reparse plus `fastlane lanes`. Si la syntaxe casse ou si
  une lane a disparu, l'écriture est annulée et l'ancienne version restaurée.
- **Sauvegarde avant écriture**, avec un historique local des versions consultable et restaurable.

Le mode texte est un vrai éditeur de code avec coloration Ruby, pas un pis-aller. Toute
modification hors du cadre structuré passe par lui, et c'est le fonctionnement attendu.

### Édition et git

Le Fastfile édité vit dans le workspace, qui est un clone géré par Homelane. La boucle est donc :
éditer, lancer la lane pour vérifier, puis committer et pousser depuis l'interface. Un panneau
« Modifications » affiche le diff.

Homelane refuse tout `checkout` par-dessus des modifications non commitées et signale l'état sale
du workspace dans l'interface.

## Interface

```
/                 Projets — statut du dernier run, Run rapide
/p/<slug>         Projet
                    ├─ Lanes            lues dans le Fastfile
                    ├─ Runs             historique filtrable
                    ├─ Fastfile         éditeur hybride + Modifications
                    ├─ Secrets          variables d'environnement
                    ├─ Préparation CI   check-list d'autonomie
                    └─ Réglages         dépôt, branche, artefacts, purge
/r/<id>           Run — étapes, terminal, artefacts
```

L'écran de run place la chronologie des étapes à gauche et le terminal à droite, les artefacts
apparaissant en bas dès qu'ils existent. La ligne de saisie est toujours présente : désactivée avec
sa raison affichée plutôt que masquée.

### Direction visuelle

Structure d'application classique — barre latérale, onglets, panneaux — avec une grammaire de
terminal à l'intérieur. Le rétro passe par la typographie et la couleur, pas par le déguisement en
fausse console.

- Chasse fixe sur toute l'interface, navigation et libellés compris.
- Marqueurs d'état en caractères (`✓ ▸ ✗ ○`) plutôt qu'icônes ; libellés en minuscules ; petites
  capitales espacées pour les titres de zone.
- Angles droits, filets d'un pixel, aucune ombre, aucun dégradé. Les surfaces se distinguent par la
  valeur, pas par la profondeur.
- Couleurs strictement sémantiques : vert succès, ambre en cours, rouge échec, bleu repère. Rien de
  décoratif. L'accent principal est le vert phosphore, variable de thème.

Deux thèmes pilotés par variables CSS : sombre par défaut, clair « papier ». **La zone terminal
reste sombre dans les deux.** Fastlane émet des couleurs ANSI pensées pour fond noir ; les
retraduire pour un fond clair est un chantier à part et trahirait la sortie réelle.

## Traitement des erreurs

| Situation | Comportement |
|---|---|
| Projet mal configuré | Détecté à l'enregistrement et avant chaque run. Le run est refusé avec un message actionnable, pas noyé dans un log. |
| Échec de lane | Code de sortie et résumé extrait du bloc d'erreur fastlane, lisible sans ouvrir le log. |
| Sidecar en échec | Les lanes deviennent illisibles ; Préparation CI le signale explicitement au lieu d'afficher une liste vide. |
| Coupure WebSocket | Le client se reconnecte et rejoue le log depuis son décalage d'octets. Aucune sortie perdue. |
| Redémarrage serveur pendant un run | Les runs orphelins passent en `interrupted` au démarrage. |
| Disque saturé | Purge configurable des logs et artefacts, plafond par projet. |

## Tests

Contrainte de fond : **aucun vrai build dans la suite de tests.**

- **Sidecar Ruby** — Fastfile-fixtures (simple, monorepo, avec plugins, Ruby biscornu) et
  instantanés du JSON produit. Plus un test de propriété sur l'aller-retour : après une édition
  structurée, seule la plage d'octets visée a changé et le fichier parse toujours.
- **Runner** — un faux exécutable `fastlane` rejoue une sortie enregistrée avec un code de sortie
  choisi. Couvre le découpage en étapes, le caviardage, la collecte d'artefacts, l'annulation et le
  timeout, en millisecondes.
- **Caviardage** — test de propriété : une valeur de secret présente dans la sortie n'apparaît
  jamais dans le log persisté.
- **API** — tests d'intégration sur un SQLite temporaire et un dépôt git créé à la volée
  (`git init` puis commit d'un Fastfile). Opérations git réelles, exécution rapide.
- **Front** — tests de composants sur la génération de formulaires depuis des métadonnées
  d'actions ; parcours Playwright de bout en bout contre le faux fastlane.

## Sécurité

- Écoute sur le réseau local, protégée par un mot de passe unique haché et une session par cookie.
- Secrets chiffrés au repos, clé dans un fichier `0600` hors base, trousseau de l'OS en option.
- Caviardage des secrets en amont de toute persistance.
- Aucune exposition Internet prévue ; un tunnel reste possible mais relève de l'utilisateur.

## Décisions ouvertes

- Format exact des unités `launchd` et `systemd`, et forme de la commande `homelane install`.
- Politique de purge par défaut : nombre de runs conservés, ou durée.
- Choix du canal de notification : notification système locale, webhook, ou les deux.

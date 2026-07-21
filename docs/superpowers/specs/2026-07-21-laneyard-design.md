# Laneyard — conception

**Date** : 2026-07-21
**État** : validé, prêt pour la planification d'implémentation

## Le problème

Déclencher, suivre et modifier des builds mobiles impose aujourd'hui de passer soit par un
terminal sur la machine de dev, soit par un service hébergé type Bitrise — facturé, opaque et
propriétaire de la chaîne de signature.

Laneyard est un serveur de build auto-hébergé bâti sur fastlane. Il tourne sur une machine que
tu possèdes, expose une interface web sur ton réseau local, et te permet de lancer des lanes,
d'en suivre l'exécution en direct et de modifier le Fastfile sans ouvrir d'éditeur.

## Périmètre

**Dans la v1**

- Plusieurs projets enregistrés, chacun cloné depuis son dépôt git.
- Déclenchement manuel d'une lane depuis l'interface, avec ses paramètres.
- Suivi en direct : logs diffusés, chronologie des actions, statut, durée.
- Historique des runs avec artefacts téléchargeables.
- Édition du Fastfile : vue structurée par actions et éditeur texte, puis commit et push.
- Configuration intégralement pilotable par fichiers, secrets exclus — sauvegardable et
  versionnable, l'interface n'étant qu'un éditeur de ces fichiers.
- Coffre de secrets injectés en variables d'environnement.
- Notifications de fin de run : notification du navigateur, plus webhook optionnel par projet.
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
- Aucune connaissance de fastlane codée en dur **dans le sidecar et dans l'éditeur** : ni noms
  d'actions, ni paramètres, ni lanes. Voir « Frontière des heuristiques » pour les deux endroits où
  des noms connus sont autorisés.
- Un secret ne doit jamais atterrir dans un fichier de log.
- Le Fastfile de l'utilisateur ne doit jamais ressortir abîmé d'une édition.

### Frontière des heuristiques

Deux fonctionnalités ont besoin de connaître fastlane par son nom : la check-list Préparation CI
(qui parle de `match`, de `MATCH_PASSWORD`, de l'App Store Connect) et l'extraction du résumé
d'erreur. Cette connaissance est autorisée, à trois conditions strictes :

1. Elle vit dans un module unique et isolé, `src/heuristics/`, jamais dispersée dans le runner,
   le sidecar ou l'éditeur.
2. Elle **ne bloque jamais et ne modifie jamais**. Une heuristique ne refuse pas un run, ne masque
   pas une lane, ne touche pas à un Fastfile. Elle produit de l'information : un avertissement
   dans la check-list, un résumé d'erreur à côté du log intégral, qui lui fait toujours foi.
3. Elle est décrite comme une table de règles déclaratives, pas comme du code impératif éparpillé,
   pour rester relisable quand fastlane évolue.

Le sidecar et l'éditeur, eux, restent à zéro connaissance codée en dur. C'est une règle absolue :
un plugin fastlane inconnu doit être aussi bien traité qu'une action officielle.

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

- **Backend tout-Ruby** — accès natif à l'API fastlane, mais Laneyard deviendrait prisonnier d'un
  environnement Ruby précis, cohabiterait mal avec les Gemfile des projets, et l'écosystème
  temps-réel y est moins praticable.
- **Binaire Go/Rust parsant la sortie texte** — déploiement idéal, mais sans l'API Ruby les
  métadonnées d'actions sont perdues et l'éditeur structuré retomberait sur une liste codée en
  dur qui se périme à chaque version de fastlane. Rédhibitoire.

Le sidecar isole entièrement Laneyard du Ruby de chaque projet tout en lui donnant accès à la
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

SQLite pour l'état d'exécution. Fichiers sur disque pour la configuration, les logs et les
artefacts : un log de build pèse plusieurs mégaoctets et n'a rien à faire en base.

```
~/.laneyard/
  config.yml             # configuration du serveur et des projets — versionnable
  laneyard.db            # runs, étapes, artefacts, secrets chiffrés, cache
  key                    # clé de chiffrement des secrets, 0600
  workspaces/<slug>/     # clones git, conservés entre les runs
  logs/<run>.log
  artifacts/<run>/
```

## Configuration par fichiers

**Toute la configuration, secrets exclus, vit dans des fichiers texte.** L'interface est un
éditeur de ces fichiers, jamais une source de vérité parallèle. Sauvegarder Laneyard, c'est copier
deux fichiers ; le restaurer sur une autre machine, c'est les recopier et ressaisir les secrets.

### `~/.laneyard/config.yml` — le serveur et ses projets

Ce que Laneyard doit savoir avant même d'avoir cloné quoi que ce soit.

```yaml
server:
  port: 7890
  bind: 0.0.0.0
  password_hash: "$argon2id$..."
  max_concurrent_runs: 1
  retention: { runs: 50, artifact_days: 30 }

projects:
  - slug: popotes-ios
    name: Popotes iOS
    git_url: git@github.com:martin/popotes.git
    default_branch: main
    git_auth: { kind: ssh_key, ref: ~/.ssh/id_ed25519 }
    color: green
    webhook_url: $SLACK_WEBHOOK      # référence de secret, jamais la valeur
```

### `laneyard.yml` dans le dépôt — le comportement de build

Facultatif, à la racine du dépôt, versionné avec le code. Il décrit comment ce projet se
construit — donc il a sa place à côté du code, comme un `bitrise.yml`.

```yaml
fastlane_dir: fastlane
runtime: bundle
timeout_minutes: 60
interactive_default: false
artifact_globs:
  - "build/**/*.ipa"
  - "build/**/*.app.dSYM.zip"
required_secrets:                    # noms seulement, jamais de valeurs
  - MATCH_PASSWORD
  - APP_STORE_CONNECT_API_KEY_ID
```

### Précédence et écriture

Champ par champ : `laneyard.yml` du dépôt, puis le bloc du projet dans `config.yml`, puis les
valeurs par défaut. L'interface affiche la provenance de chaque réglage — un réglage venu du dépôt
est signalé comme tel, et le modifier produit une modification git à committer, exactement comme
une édition du Fastfile. Les réglages de `config.yml` sont écrits directement.

Les fichiers sont surveillés : une modification à la main est prise en compte sans redémarrage.
Un fichier invalide est signalé dans l'interface et l'ancienne configuration valide reste active —
jamais de démarrage à moitié configuré.

**Un secret ne figure jamais dans un fichier de configuration.** Ces fichiers ne peuvent que
déclarer des noms de secrets ou y faire référence par `$NOM`.

## Modèle de données

SQLite ne contient que l'état d'exécution et les secrets. Aucune table `project` : la liste des
projets vient de `config.yml`, et les runs référencent un projet par son `slug`. Retirer un projet
du fichier ne détruit pas son historique, qui reste consultable.

### `secret`

| Champ | Type | Rôle |
|---|---|---|
| `project_slug` | text? | Portée : un projet, ou nul pour un secret global |
| `key` | text | Nom de la variable d'environnement |
| `value_enc` | blob | Chiffré au repos, AES-GCM, clé hors base |
| `masked` | bool | Si vrai : jamais réaffiché dans l'UI, caviardé dans les logs |

### `run`

| Champ | Type | Rôle |
|---|---|---|
| `project_slug`, `lane`, `platform` | — | Ce qui a été lancé |
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
| `run_id`, `idx`, `name` | — | Ordre et nom de l'action, issus de `report.xml` |
| `duration_ms`, `status` | — | Issus de `report.xml`. Repérer l'étape lente ou fautive |
| `started_at` | ts | Calculé par cumul des durées depuis le début du run |
| `log_offset` | int? | Position dans le log, issue du repérage en direct. Nulle si l'étape n'a pas été repérée |
| `source` | text | `report` ou `live` — d'où vient la ligne, voir ci-dessous |

### `artifact`

| Champ | Type | Rôle |
|---|---|---|
| `run_id`, `filename`, `path`, `size` | — | Fichier déplacé hors du workspace |
| `kind` | text | `ipa` · `apk` · `aab` · `dsym` · `other` |

### Quatre absences volontaires

- **Aucune table `project`.** La configuration vit dans les fichiers, jamais en base. Voir
  « Configuration par fichiers ».
- **Aucune table `lane`.** Les lanes vivent dans le Fastfile. Laneyard les lit via le sidecar et
  met le résultat en cache dans une table `introspection_cache` (`project_slug`, `config_hash`,
  `payload` JSON, `fetched_at`), une ligne par projet, écrasée à chaque changement d'empreinte.
  L'empreinte couvre **tout le `fastlane_dir`**, pas seulement le Fastfile : un `Appfile`, un
  `Pluginfile` ou un fichier importé modifie les lanes tout autant.
  C'est un cache, pas une source : une empreinte différente le rend caduc immédiatement, et le
  vider n'a aucune conséquence hormis une lecture plus lente. L'interface ne peut donc pas
  afficher une lane qui n'existe plus.
- **Aucune table `user`.** Un mot de passe haché en configuration. Le multi-utilisateur n'a pas de
  sens pour un outil auto-hébergé personnel.
- **Aucun log en base.** Un fichier par run, diffusé en direct puis relu à la demande.

## Cycle de vie d'un run

1. **Déclenchement** → `queued`. Le formulaire de paramètres est généré depuis la signature réelle
   de la lane. Le run est créé en base immédiatement : même en attente, il est visible.
2. **File d'attente.** Un run par projet, limite globale configurable.
3. **Préparation** → `preparing`. Au premier run d'un projet, le workspace n'existe pas encore :
   il est créé par un clone complet, opération visible dans les logs du run avec sa propre étape,
   car sur un gros dépôt elle dure. Le clone initial peut aussi être déclenché à l'enregistrement
   du projet, ce qui permet de lire les lanes avant tout run. Ensuite, `git fetch` puis
   `checkout` dans le workspace du projet,
   conservé entre les runs donc rapide, nettoyable sur demande. Le SHA est enregistré. Si le
   `Gemfile.lock` a changé, `bundle install` tourne d'abord. Les secrets sont déchiffrés en
   mémoire et préparés en variables d'environnement.
4. **Exécution** → `running`. fastlane est lancé dans un pseudo-terminal : il conserve ses
   couleurs et son affichage habituel. Chaque fragment de sortie part vers trois destinations —
   le fichier de log, les navigateurs connectés, un tampon pour les connexions tardives.
5. **Fin.** Le code de sortie décide. En cas d'échec, le résumé d'erreur est extrait du bloc
   d'erreur de fastlane par le module d'heuristiques. Les artefacts sont collectés, puis déplacés
   hors du workspace pour survivre au prochain build.
6. **Annulation.** `SIGINT` au groupe de processus — fastlane fait son ménage — puis `SIGKILL`
   s'il s'obstine. Délai maximum par run, 60 min par défaut.

### D'où vient la chronologie des étapes

fastlane écrit à chaque exécution un rapport JUnit dans `<fastlane_dir>/report.xml`, avec une
entrée par action : index, nom, durée, et le détail en cas d'échec. Comportement vérifié sur une
exécution réelle :

```xml
<testcase classname="fastlane.lanes" name="0: echo inner" time="0.007099"/>
```

Ce fichier fait autorité pour les noms, l'ordre, les durées et les échecs. Il est lu en fin de run,
alimente `run_step`, puis est supprimé du workspace pour ne pas polluer le dépôt.

Pendant l'exécution, ce rapport n'existe pas encore. L'affichage en direct s'appuie donc sur un
repérage des séparateurs d'étape dans la sortie. De ce repérage, une seule chose est conservée :
la **position en octets** où chaque étape a commencé dans le log, qui alimente `log_offset` et
permet de cliquer une étape pour sauter au bon endroit — `report.xml` ne contient aucune position.
Les noms et durées issus du repérage en direct sont, eux, jetés à la fin.

La réconciliation est un appariement par index. Si le repérage a manqué une étape, le décalage
correspondant est nul et le saut au log est simplement indisponible pour celle-là : une
dégradation visible et sans conséquence.

**Quand `report.xml` n'existe pas** — run annulé, expiré, interrompu par un redémarrage, ou échec
avant même le lancement de fastlane (clone, `bundle install`) — les lignes issues du repérage en
direct sont conservées telles quelles, avec `source = live`. L'interface indique alors que la
chronologie est partielle. Un run qui n'a jamais atteint fastlane n'a tout simplement aucune étape.

Cette séparation est délibérée : le confort d'affichage repose sur une heuristique fragile, la
donnée qui fait foi repose sur un format structuré produit par fastlane lui-même.

### Collecte des artefacts

Le `lane_context` de fastlane, qui contient les chemins de sortie, n'est pas accessible depuis un
sous-processus. Les artefacts sont donc collectés par **motifs de fichiers configurés par projet**
(`artifact_globs`), évalués sur le workspace après le run. C'est le contrat, explicite et
prévisible.

À l'enregistrement d'un projet, des motifs par défaut sont proposés selon ce qui est détecté dans
le dépôt — `**/*.ipa`, `**/*.app.dSYM.zip` pour un projet iOS, `**/*.apk`, `**/*.aab` pour Android
— modifiables ensuite. Aucun chemin n'est deviné en analysant la sortie du run.

### Mode non-interactif par défaut

Les runs tournent avec `CI=true`. Un run qui aurait besoin d'une saisie échoue immédiatement avec
un message actionnable, au lieu de rester figé sur un prompt invisible. Une case « mode
interactif » au lancement, et un réglage par projet, rouvrent les prompts pour les phases de mise
en place (première utilisation de `match`, découverte d'un device).

Le PTY est utilisé dans les deux cas : il donne la sortie colorée, l'affichage fastlane normal, et
une porte de sortie quand un run se bloque malgré tout.

L'écran **Préparation CI** est ce qui rend un projet autonome. Check-list recalculée à la demande,
jamais automatiquement — chaque vérification a un coût. Aucun item ne bloque un run : ce sont des
avertissements, conformément à la frontière des heuristiques.

| Item | Détection | Remédiation proposée |
|---|---|---|
| Dépôt accessible sans mot de passe | `git ls-remote` avec un délai court et `GIT_TERMINAL_PROMPT=0`. Échec ou demande de saisie = rouge. | Formulaire : chemin d'une clé SSH, ou saisie d'un token stocké comme secret. |
| Dépendances installables | Présence d'un `Gemfile`, puis `bundle check`. Sans `Gemfile`, on vérifie que `fastlane` est dans le `PATH` et le signale comme configuration `system`. | Bouton lançant `bundle install` et affichant sa sortie. |
| Authentification App Store Connect | Recherche d'un secret de clé API (`APP_STORE_CONNECT_API_KEY_*`) ou d'un `FASTLANE_SESSION` dans le coffre du projet. Session seule = orange, avec l'explication qu'elle expire. | Formulaire de clé API : identifiant de clé, identifiant d'émetteur, contenu du `.p8`. Le tout stocké comme secrets masqués. |
| `match` utilisable sans intervention | Le Fastfile utilise-t-il `match` ou `sync_code_signing` — information venant du sidecar, pas d'une lecture textuelle ? Si oui : `MATCH_PASSWORD` est-il présent dans le coffre, et le paramètre `readonly` est-il à vrai dans l'appel ? | Formulaire d'ajout du secret ; pour `readonly`, un renvoi vers l'action dans l'éditeur. |
| Aucune action réputée bloquante | Croisement des actions listées par le sidecar avec la table de règles du module d'heuristiques (actions connues pour attendre une saisie, par exemple `prompt`). | Aucune action automatique : simple avertissement indiquant que le mode interactif sera nécessaire. |

Chaque item est un couple détection/remédiation indépendant, ajouté un par un. La table de règles
n'est consultée que pour le dernier item.

### Caviardage des secrets

Les valeurs des secrets marqués `masked` sont remplacées dans le flux **avant** écriture disque et
avant diffusion WebSocket. Ce n'est pas un filtrage d'affichage : la valeur n'existe jamais dans un
fichier de log.

Un remplacement naïf fragment par fragment ne suffit pas : un PTY découpe la sortie où il veut, et
un secret peut se trouver coupé entre deux fragments. Le filtre conserve donc un tampon glissant
d'au moins la longueur du plus long secret moins un octet, et ne relâche que ce qui ne peut plus
faire partie d'une correspondance. Le test de propriété correspondant doit découper la sortie de
test à des positions arbitraires, sans quoi il ne détecte rien.

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
- **Sauvegarde avant écriture**, restaurée automatiquement si la vérification échoue. Un historique
  navigable des versions n'est pas nécessaire en v1 : git remplit déjà ce rôle dès que la
  modification est commitée.

Le mode texte est un vrai éditeur de code avec coloration Ruby, pas un pis-aller. Toute
modification hors du cadre structuré passe par lui, et c'est le fonctionnement attendu.

### Édition et git

Le Fastfile édité vit dans le workspace, qui est un clone géré par Laneyard. La boucle est donc :
éditer, lancer la lane pour vérifier, puis committer et pousser depuis l'interface. Un panneau
« Modifications » affiche le diff.

Laneyard refuse tout `checkout` par-dessus des modifications non commitées et signale l'état sale
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
                    └─ Réglages         édition des fichiers de configuration
/r/<id>           Run — étapes, terminal, artefacts
```

L'onglet Réglages présente les valeurs effectives et, pour chacune, le fichier d'où elle vient.
Modifier une valeur définie dans le dépôt produit une modification git à committer ; modifier une
valeur du serveur écrit dans `config.yml`. Une bascule permet d'éditer directement le YAML brut,
comme l'éditeur de Fastfile propose son mode texte.

L'écran de run place la chronologie des étapes à gauche et le terminal à droite, les artefacts
apparaissant en bas dès qu'ils existent. La ligne de saisie est toujours présente : désactivée avec
sa raison affichée plutôt que masquée.

### Notifications

Deux canaux, tous deux configurés dans les Réglages du projet.

**Notification du navigateur.** L'API `Notification` du navigateur, déclenchée à la réception de
l'événement de fin de run sur le WebSocket. Aucun serveur de push, aucun service tiers, aucune
dépendance système. Contrepartie assumée : elle ne fonctionne que si un onglet Laneyard est
ouvert. C'est le cas d'usage réel — tu lances un build puis tu passes à autre chose sur la même
machine.

**Webhook.** Une URL par projet, appelée en POST avec un corps JSON décrivant le run terminé :
identifiant, projet, lane, statut, durée, commit, liste des artefacts. C'est le point
d'accroche pour Slack, ntfy, Discord ou n'importe quel script personnel. Les valeurs de secrets
n'y figurent jamais.

Une notification système native est explicitement écartée : elle s'afficherait sur la machine de
build, que personne ne regarde.

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

## Jalons

Le périmètre v1 couvre cinq sous-systèmes largement indépendants — sidecar Ruby, runner PTY,
coffre de secrets, éditeur hybride, interface. Le plan d'implémentation doit viser une **tranche
verticale le plus tôt possible** plutôt qu'un empilement de couches :

1. **Le fil complet.** Déclarer un projet dans `config.yml`, cloner, lister les lanes via le
   sidecar, lancer une lane, voir les logs en direct, récupérer un artefact. La configuration par
   fichiers vient d'abord : elle est le socle de tout le reste, et l'écrire après signifierait
   démonter une couche de persistance déjà écrite.
2. **Fiabilité du run.** Caviardage, file d'attente, annulation, timeout, runs interrompus,
   chronologie depuis `report.xml`.
3. **Secrets et Préparation CI.** Le coffre, puis les items de check-list un par un.
4. **Éditeur.** D'abord le mode texte avec vérification et sauvegarde, ensuite seulement la vue
   structurée — le mode texte seul est déjà utile, l'inverse n'est pas vrai.
5. **Finitions.** Notifications, purge, thèmes, installation en service.

## Décisions ouvertes

- Format exact des unités `launchd` et `systemd`, et forme de la commande `laneyard install`.
- Politique de purge par défaut, à confirmer à l'usage : proposition initiale de 50 runs conservés
  par projet et 30 jours de rétention pour les artefacts, les logs suivant leur run.

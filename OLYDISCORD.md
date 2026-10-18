# OLYDISCORD

Surcouche Discord basée sur un fork de [Vencord](https://github.com/Vendicated/Vencord) (GPL-3.0).
Elle ajoute des fonctionnalités « façon Nitro » **visibles uniquement par les autres utilisateurs d'OLYDISCORD**,
grâce à un serveur que tu héberges toi-même :

| Fonctionnalité | Utilisateur Oly | Utilisateur Discord normal |
|---|---|---|
| PP et bannière animées (GIF, WebP), recadrées à l'envoi, réglées depuis l'éditeur de profil de Discord | Les voit | Voit la PP Discord normale |
| Icône et bannière animées d'un serveur, réglées dans Paramètres du serveur → Profil du serveur (permission « Gérer le serveur ») | Les voit | Voit l'icône Discord normale |
| Icônes GIF de serveur toujours animées (Discord ne les anime qu'au survol) | Les voit | — |
| Fichiers lourds (2 Go par défaut) | Pièce jointe intégrée : lecteur vidéo/audio, image, carte de téléchargement | Lien de téléchargement |
| Soundboard Oly : sons perso (utilisables partout) et sons de serveur, sans limite de boost | Les entend dans son salon vocal | N'entend rien |
| Badge « Utilisateur OLYDISCORD » | Le voit | — |

Rien ne passe par les serveurs de Discord : pas de faux Nitro, juste une couche en plus.

```
Discord + OLYDISCORD (ce dépôt, src/olyplugins/olydiscord.desktop)
   │  HTTPS (jeton Oly, jamais le token Discord)
   ▼
server/ (Fastify + SQLite)  ──►  data/blobs (fichiers dédupliqués)
   ▲
Cloudflare Tunnel (https://oly.ton-domaine)
```

## Organisation du dépôt

- `src/olyplugins/olydiscord.desktop/` : le plugin (client)
  - `api.ts` : appels au serveur, connexion, envoi en morceaux
  - `patches.ts` : patchs du code de Discord (avatar, bannière, icônes de serveur, sections des éditeurs de profil)
  - `index.tsx` : branchement des patchs, bouton d'envoi, rendu des pièces jointes, badge
  - `components/` : réglages, recadrage, sections OLYDISCORD des éditeurs de profil et pièces jointes
- `scripts/olyCheckPatches.mjs` : vérifie les patchs contre le code actuel de Discord
- `server/` : le serveur Oly
- `oly.config.json` : URL du serveur, intégrée au client **au moment du build**
- Le reste est Vencord. `upstream` = Vencord officiel, `origin` = ton fork.

Modifications faites dans le code Vencord (à surveiller lors des mises à jour) :
`scripts/build/common.mjs` et `build.mjs` (dossier `olyplugins`, constante `OLY_SERVER_URL`),
`src/globals.d.ts`, `src/main/csp/index.ts` (autorisation du domaine Oly).

## 1. Serveur

### Application Discord (OAuth)

1. <https://discord.com/developers/applications> → *New Application* (tu peux aussi réutiliser celle du bot)
2. **OAuth2** → copie *Client ID* et *Client Secret*
3. **OAuth2 → Redirects** → ajoute `<PUBLIC_URL>/auth/callback` (ex. `https://oly.ton-domaine.fr/auth/callback`,
   et `http://localhost:8787/auth/callback` pour tester en local)

### Lancement

```bash
cd server
cp .env.example .env   # remplis DISCORD_CLIENT_ID / SECRET, PUBLIC_URL, ALLOWED_USER_IDS…
npm install
npm run dev            # http://localhost:8787
```

En production sur la box :

```bash
cd server
mkdir -p data && sudo chown 1000:1000 data   # le conteneur tourne en utilisateur node (uid 1000)
docker compose --profile prod up -d --build
```

- **Tunnel Cloudflare déjà en place** sur la machine (cas du mini-PC `ak1`, qui fait tourner le bot musique) : copie
  `docker-compose.override.example.yml` en `docker-compose.override.yml`. Le serveur rejoint alors le réseau Docker du
  bot, et le tunnel existant le joint sous le nom `olydiscord`.
- **Tunnel dédié** : mets `TUNNEL_TOKEN` dans `.env` et ajoute `--profile tunnel` à la commande.

Dans Cloudflare Zero Trust → Tunnels → le tunnel → *Public Hostname* : `discord.olycity.fr` → `HTTP` → `olydiscord:8787`.
Pense aussi à la redirection OAuth `https://discord.olycity.fr/auth/callback` dans le portail Discord.

Mise à jour du serveur sur la box :

```bash
cd /root/olydiscord && git pull && cd server && docker compose --profile prod up -d --build
```

### Gestion du stockage

| Réglage (`.env`) | Défaut | Rôle |
|---|---|---|
| `MAX_FILE_SIZE_MB` | 2048 | Taille max d'un fichier |
| `USER_QUOTA_MB` | 5120 | Espace par utilisateur (fichiers non expirés + envois en cours) |
| `GLOBAL_MAX_GB` | 200 | Plafond total, au-delà les envois sont refusés (507) |
| `MIN_FREE_DISK_GB` | 10 | Réserve de disque libre toujours préservée |
| `FILE_TTL_DAYS` | 30 | Durée de vie d'un fichier (prolongeable depuis les réglages) |
| `CHUNK_SIZE_MB` | 50 | Taille des morceaux : **≤ 95**, Cloudflare Tunnel refuse les requêtes > 100 Mo |
| `STALE_UPLOAD_HOURS` | 24 | Un envoi abandonné est supprimé après ce délai |
| `ALLOWED_USER_IDS` | (vide) | Liste blanche d'IDs Discord : **conseillé** pour réserver le serveur à tes amis |

- **Déduplication** : un même fichier envoyé deux fois n'est stocké qu'une fois (SHA-256).
  Le quota compte quand même chaque envoi pour son auteur.
- **Nettoyage** toutes les 10 min : fichiers expirés, envois abandonnés, fichiers temporaires orphelins,
  blobs plus utilisés. C'est à ce moment que le disque est réellement libéré.
- **Suivi** : `GET /admin/stats` (IDs dans `ADMIN_USER_IDS`) donne le disque, l'espace stocké et le top des utilisateurs.
- Les PP/bannières sont recadrées puis converties en WebP (512×512 et 1200×480, animation conservée pour GIF/WebP ; un APNG devient fixe). Elles n'expirent pas et ne comptent pas dans le quota (15 Mo max à l'envoi).

### API

| Route | Rôle |
|---|---|
| `POST /auth/start`, `GET /auth/callback`, `GET /auth/poll/:id` | Connexion via le navigateur (OAuth Discord, scopes `identify guilds` : `guilds` sert seulement à vérifier qui peut gérer un serveur) |
| `GET /me`, `GET /me/files`, `DELETE /me` | Compte, quota, fichiers, suppression du compte |
| `POST /uploads` → `PUT /uploads/:id/chunks/:n` → `POST /uploads/:id/complete` | Envoi en morceaux, parallèle et reprenable (`GET /uploads/:id`) |
| `GET /f/:id/:nom` | Téléchargement public (lien non devinable), lecture vidéo avec avance rapide (Range) |
| `GET /files/:id`, `DELETE /files/:id`, `POST /files/:id/extend` | Métadonnées, suppression, prolongation |
| `PUT/DELETE /me/avatar`, `PUT/DELETE /me/banner`, `GET /profiles` | Profils Oly (utilisateurs et serveurs), recadrage via `?x=&y=&w=&h=` |
| `PUT/DELETE /guilds/:id/icon`, `PUT/DELETE /guilds/:id/banner` | Icône/bannière Oly d'un serveur (vérifie « Gérer le serveur » via Discord, sinon `403 REAUTH`) |
| `GET /sounds?guilds=…`, `POST /sounds?name=&emoji=&guildId=`, `DELETE /sounds/:id` | Soundboard : sons perso et de serveur (ajout sur un serveur avec « Créer des expressions ») |
| `GET /ws` (WebSocket) | Temps réel : le client s'authentifie dans son premier message, indique son salon vocal ; les sons joués sont relayés aux utilisateurs Oly du même salon (3 sons / 5 s max) |

## 2. Installer chez un ami (Windows)

1. Ouvrir la [dernière release](https://github.com/liam-thorel/olydiscord/releases/latest) et télécharger
   **Installer-OLYDISCORD.cmd**.
2. Double-cliquer dessus. Si Windows affiche un avertissement de sécurité, choisir *Exécuter* (ou *Informations complémentaires →
   Exécuter quand même*). Discord se ferme puis se relance avec OLYDISCORD.
3. Dans Discord : *Paramètres → Profils* → section **OLYDISCORD** → *Se connecter à OLYDISCORD*, puis autoriser dans le navigateur.

Les mises à jour arrivent toutes seules (*Paramètres → Vencord → Updater*). Pour revenir au Discord normal :
**Desinstaller-OLYDISCORD.cmd**. Pour Discord PTB ou Canary, lancer le `.cmd` depuis un terminal avec `-Branch ptb`
(ou `canary`).

Comment ça marche : à chaque modification de `main`, le workflow `.github/workflows/oly-release.yml` compile la version
« standalone » et met à jour la release `olydiscord`. Le script `scripts/install-olydiscord.ps1` télécharge ces
fichiers dans `%APPDATA%OLYDISCORDdist` et utilise l'installeur officiel de Vencord pour les injecter dans Discord.
Une installation existante du Vencord officiel est remplacée.

### Tester le soundboard tout seul

Il faut deux comptes Discord avec OLYDISCORD dans le même salon vocal. Sans ami sous la main :

1. Installer [Discord PTB](https://discord.com/download) (s'installe à côté du Discord normal) et s'y connecter avec un
   second compte.
2. Installer OLYDISCORD dans PTB : dans un terminal, `.Installer-OLYDISCORD.cmd -Branch ptb`.
3. Se connecter à OLYDISCORD dans PTB, puis rejoindre le même salon vocal avec les deux comptes.
4. Dans un des deux : bouton **Soundboard** de la barre de saisie → ajouter un son → le jouer. L'autre doit l'entendre.

## 3. Compiler le client (développement)

Prérequis : Node.js 22+ et pnpm (`npx pnpm@11.9.0 …` fonctionne sans l'installer).

1. Mets l'URL publique du serveur dans `oly.config.json` (ou la variable `OLY_SERVER_URL` au build).
2. Compile et installe dans Discord :

```bash
npx pnpm@11.9.0 install --frozen-lockfile
npx pnpm@11.9.0 build
npx pnpm@11.9.0 inject
```

3. Redémarre Discord → Réglages → Vencord → Plugins → active **OLYDISCORD** → bouton ⚙ → *Se connecter avec Discord*.
4. Dans la barre de saisie, le bouton ⬆ envoie un fichier lourd. Le lien est inséré dans le message :
   les utilisateurs Oly le voient comme une pièce jointe.

> ⚠ USRBG et OLYDISCORD patchent le même endroit pour les bannières : n'active pas les deux.

### Après une mise à jour de Discord

- **Appli Discord mise à jour** (nouveau dossier `app-1.0.xxxx`) : Vencord se réinstalle tout seul dedans au démarrage suivant.
- **Code de Discord modifié** : les patchs de `patches.ts` repèrent des morceaux précis du code minifié de Discord. S'ils
  ne correspondent plus, la fonctionnalité concernée disparaît (Discord continue de marcher) et la console Vencord affiche
  *Patch by OLYDISCORD had no effect*.

Pour le savoir sans attendre :

```bash
node scripts/olyCheckPatches.mjs
```

Le script télécharge le client web de Discord (environ 6 000 fichiers, gardés en cache dans le dossier temporaire),
vérifie que chaque `find` désigne un seul module, que chaque `match` s'applique (sur toutes les copies d'un module),
et que le code patché reste valide. Il affiche un rapport et sort en erreur si un patch est cassé. Le code de Discord est
seulement analysé, jamais exécuté.

Le workflow GitHub `.github/workflows/oly-patch-check.yml` le lance **chaque jour** : en cas de casse, il ouvre (ou complète)
l'issue « Patchs OLYDISCORD cassés par une mise à jour de Discord » avec le rapport, et la ferme quand tout redevient valide.
Il vérifie `main` (variable `OLY_REF`). On peut aussi le lancer à la main sur une autre branche :
*Actions → Patchs OLYDISCORD → Run workflow*.

Pour réparer : corrige le motif dans `patches.ts` (le rapport indique lequel), relance le script, puis `pnpm build`.

### Récupérer les mises à jour de Vencord

```bash
git fetch upstream
git merge upstream/main
```

## Limites connues / prochaines étapes

- Les images Oly sont toujours animées (pas de version fixe au repos) → générer une première image fixe côté serveur.
- L'icône/bannière Oly d'un serveur ne remplace que celles qui existent déjà sur Discord : un serveur sans icône garde ses initiales.
- Discord affiche aussi son propre aperçu du lien Oly en plus de la pièce jointe → masquer l'embed pour les liens Oly.
- Glisser-déposer / coller un gros fichier passe encore par Discord → intercepter au-delà de la limite Discord.
- Le soundboard Oly n'est entendu que par les utilisateurs Oly : les sons ne passent pas par la voix Discord. Il a son propre bouton (barre de saisie) au lieu d'être intégré au soundboard de Discord.
- Pas encore de miniatures vidéo, d'emojis/stickers Oly ni de couleurs de profil (le champ `accentColor` existe déjà côté serveur).
- Renommer l'interface (« Vencord » → « OLYDISCORD ») et l'installeur.

## Avertissements

- Les mods client sont **interdits par les conditions d'utilisation de Discord** : chaque utilisateur prend un
  (faible) risque de suspension de compte.
- Fork de Vencord sous **GPL-3.0** : si tu distribues OLYDISCORD, son code source doit rester public.
- Tu es responsable de ce que ton serveur héberge : garde `ALLOWED_USER_IDS` rempli et supprime ce qui pose problème
  (`DELETE /files/:id` en tant qu'admin).

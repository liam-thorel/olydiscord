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
  - `index.tsx` : patchs Discord (avatar, bannière), bouton d'envoi, rendu des pièces jointes, badge
  - `components/` : réglages (compte, PP/bannière, stockage, mes fichiers) et pièces jointes
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

Dans Cloudflare Zero Trust → Tunnels : ajoute un nom public (ex. `oly.ton-domaine.fr`) → `http://olydiscord:8787`.

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

## 2. Client

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

Les patchs de `index.tsx` dépendent du code de Discord. S'ils ne s'appliquent plus, la console Vencord le signale
(*Patch by OLYDISCORD had no effect*). Vencord fournit un outil pour tester tous les patchs : `pnpm buildReporter`,
voir la doc Vencord.

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
- Pas encore de miniatures vidéo, d'emojis/stickers Oly ni de couleurs de profil (le champ `accentColor` existe déjà côté serveur).
- Renommer l'interface (« Vencord » → « OLYDISCORD ») et l'installeur.

## Avertissements

- Les mods client sont **interdits par les conditions d'utilisation de Discord** : chaque utilisateur prend un
  (faible) risque de suspension de compte.
- Fork de Vencord sous **GPL-3.0** : si tu distribues OLYDISCORD, son code source doit rester public.
- Tu es responsable de ce que ton serveur héberge : garde `ALLOWED_USER_IDS` rempli et supprime ce qui pose problème
  (`DELETE /files/:id` en tant qu'admin).

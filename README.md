# VHOA — API

NestJS 11 · Prisma 7 (Neon Postgres) · Cloudflare R2 · OpenAI · RevenueCat · Expo Push. Hébergement : Railway.

## Démarrer en local

```bash
cp .env.example .env      # puis remplir les valeurs
npm install
npx prisma migrate dev    # applique les migrations sur Neon
npm run start:dev         # http://localhost:3000/v1  (santé : /health)
npm test                  # tests unitaires
```

## Déployer sur Railway

1. Nouveau service depuis le repo `vhoa-api` (le fichier `railway.json` règle le build et le démarrage).
2. Copier toutes les variables du `.env` dans **Variables**, avec `NODE_ENV=production`.
3. Au démarrage, `prisma migrate deploy` applique les migrations automatiquement.
4. Créer le service dans la **même région** que la base Neon (latence divisée par 5 à 10).

ffmpeg est fourni par le paquet `ffmpeg-static` : rien à installer sur le serveur.

## Ce qu'il faut configurer à l'extérieur

| Service | Où | Valeur |
| --- | --- | --- |
| **R2** | Bucket > Settings > Public access | domaine personnalisé → `R2_PUBLIC_BASE_URL` (https) |
| **R2** | Bucket > Settings > CORS | inutile (envoi depuis l'app native, pas un navigateur) |
| **Apple** | developer.apple.com > Identifiers | activer *Sign in with Apple* sur `com.vhoa.app` |
| **Google** | Google Cloud > Identifiants | clients OAuth *Web*, *iOS*, *Android* → `GOOGLE_CLIENT_IDS` |
| **RevenueCat** | Integrations > Webhooks | URL `https://<api>/v1/webhooks/revenuecat`, en-tête Authorization = `REVENUECAT_WEBHOOK_AUTH` |
| **RevenueCat** | Project > API keys | clé secrète v1 → `REVENUECAT_SECRET_KEY` ; entitlement `premium` |
| **Expo** | expo.dev > projet | `eas init` dans l'app pour obtenir le `projectId` (nécessaire au push) |

## Rendre un compte admin

```bash
npm run admin:grant -- <pseudo>
```

Routes admin (`/v1/admin/...`) : thèmes (créer, modifier, régénérer), signalements, contestations,
retrait / restauration de posts, bannissement.

## Fonctionnement

- **Médias** : l'app demande une URL signée (`POST /posts`), envoie le fichier directement sur R2,
  puis confirme (`POST /posts/:id/submit`). Le serveur vérifie la signature binaire du fichier,
  convertit en 720p max / 60 s max, extrait une miniature, transcrit et modère. Le fichier brut est supprimé.
- **Coach IA** : débit, mots parasites et silences sont calculés par le serveur à partir de la
  transcription mot à mot (aucun coût GPT). GPT ne rédige que le retour (court en gratuit, détaillé en Premium).
  Gratuit : 1 analyse par mois.
- **Thèmes** : GPT propose le sujet de la semaine / du mois suivant à l'avance ; l'admin peut le modifier.
  Participation et vote « Convaincu » sont ouverts pendant tout le thème ; podium à la clôture.
- **Tâches de fond** : file de tâches dans Postgres (pas de Redis) ; tâches planifiées protégées par
  un verrou en base (une seule instance les exécute).

## Sécurité (résumé)

Jetons d'accès 15 min + jetons de renouvellement à usage unique (rotation, détection de vol),
argon2id, verrouillage après 5 échecs, limitation de débit par compte / IP, validation stricte des
entrées (champs inconnus refusés), helmet, aucune erreur interne exposée, webhooks vérifiés en temps
constant, modération OpenAI des textes et images, signature binaire des fichiers vérifiée avant ffmpeg.

Limites connues :

- la limitation de débit est en mémoire : au-delà d'une instance Railway, passer à un stockage partagé (Redis) ;
- sans envoi d'email, pas de réinitialisation de mot de passe ni de vérification d'adresse ;
- à la suppression d'un compte Apple, la révocation du jeton Apple (exigée par l'App Store) reste à ajouter
  (clé privée « Sign in with Apple » nécessaire).

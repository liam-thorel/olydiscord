import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const idList = z
  .string()
  .default("")
  .transform(s => new Set(s.split(",").map(x => x.trim()).filter(Boolean)));

const schema = z.object({
  PORT: z.coerce.number().int().default(8787),
  /** URL publique du serveur (sans / final), utilisée pour l'OAuth et les liens de fichiers */
  PUBLIC_URL: z.url().default("http://localhost:8787").transform(u => u.replace(/\/+$/, "")),
  DATA_DIR: z.string().default("./data").transform(p => resolve(p)),

  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),

  /** Vide = tout le monde peut se connecter ; sinon seuls ces IDs Discord */
  ALLOWED_USER_IDS: idList,
  /** Accès à /admin/stats */
  ADMIN_USER_IDS: idList,

  // ── Stockage ─────────────────────────────────────────────
  MAX_FILE_SIZE_MB: z.coerce.number().positive().default(2048),
  USER_QUOTA_MB: z.coerce.number().positive().default(5120),
  /** Taille totale maximale de tous les fichiers stockés */
  GLOBAL_MAX_GB: z.coerce.number().positive().default(200),
  /** On refuse les envois si le disque passerait sous ce seuil */
  MIN_FREE_DISK_GB: z.coerce.number().nonnegative().default(10),
  FILE_TTL_DAYS: z.coerce.number().positive().default(30),
  /** Cloudflare Tunnel (gratuit) refuse les requêtes > 100 Mo */
  CHUNK_SIZE_MB: z.coerce.number().positive().max(95).default(50),
  MAX_PROFILE_IMAGE_MB: z.coerce.number().positive().default(15),
  /** Envoi commencé mais jamais terminé : supprimé après ce délai */
  STALE_UPLOAD_HOURS: z.coerce.number().positive().default(24),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Configuration invalide (.env) :\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

const env = parsed.data;
const MB = 1024 * 1024;
const GB = 1024 * MB;

export const config = {
  ...env,
  maxFileSize: env.MAX_FILE_SIZE_MB * MB,
  userQuota: env.USER_QUOTA_MB * MB,
  globalMax: env.GLOBAL_MAX_GB * GB,
  minFreeDisk: env.MIN_FREE_DISK_GB * GB,
  fileTtlMs: env.FILE_TTL_DAYS * 24 * 3600_000,
  chunkSize: Math.floor(env.CHUNK_SIZE_MB * MB),
  maxProfileImage: env.MAX_PROFILE_IMAGE_MB * MB,
  staleUploadMs: env.STALE_UPLOAD_HOURS * 3600_000,
};

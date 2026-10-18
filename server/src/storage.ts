import { createHash } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { mkdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { db } from "./db.js";
import { formatBytes, httpError } from "./util.js";

export const BLOBS_DIR = join(config.DATA_DIR, "blobs");
export const TMP_DIR = join(config.DATA_DIR, "tmp");

await mkdir(BLOBS_DIR, { recursive: true });
await mkdir(TMP_DIR, { recursive: true });

/** Chemin relatif à BLOBS_DIR (réparti en sous-dossiers pour ne pas avoir 100 000 fichiers au même endroit) */
export const blobRelPath = (sha: string) => `${sha.slice(0, 2)}/${sha}`;
export const blobPath = (sha: string) => join(BLOBS_DIR, blobRelPath(sha));
export const tmpPath = (uploadId: string) => join(TMP_DIR, uploadId);

const sum = (sql: string, ...params: (string | number)[]) =>
  ((db.prepare(sql).get(...params) as { total: number | null }).total ?? 0);

/** Espace compté pour l'utilisateur : ses fichiers non expirés + les envois en cours (réservés) */
export function userUsage(userId: string): number {
  return (
    sum(
      `SELECT SUM(size) AS total FROM files WHERE owner_id = ? AND kind = 'upload' AND (expires_at IS NULL OR expires_at > ?)`,
      userId,
      Date.now(),
    ) + sum(`SELECT SUM(size) AS total FROM uploads WHERE owner_id = ?`, userId)
  );
}

/** Espace réellement occupé sur le disque (blobs dédupliqués + envois en cours) */
export function globalUsage(): number {
  return sum(`SELECT SUM(size) AS total FROM blobs`) + sum(`SELECT SUM(size) AS total FROM uploads`);
}

export async function diskStats() {
  const s = await statfs(config.DATA_DIR);
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
}

/** Lève une erreur si l'utilisateur ou le serveur n'a pas la place pour `size` octets de plus */
export async function assertCapacity(userId: string, size: number, countsForQuota: boolean) {
  if (countsForQuota) {
    const used = userUsage(userId);
    if (used + size > config.userQuota) {
      throw httpError(
        413,
        `Quota dépassé : ${formatBytes(used)} utilisés sur ${formatBytes(config.userQuota)}. Supprime d'anciens fichiers.`,
      );
    }
  }
  if (globalUsage() + size > config.globalMax) {
    throw httpError(507, "Le serveur OLYDISCORD est plein, réessaie plus tard.");
  }
  const { free } = await diskStats();
  if (free - size < config.minFreeDisk) {
    throw httpError(507, "Le disque du serveur OLYDISCORD est presque plein, réessaie plus tard.");
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Range un fichier temporaire dans les blobs. S'il existe déjà un blob identique,
 * le fichier temporaire est simplement supprimé (déduplication).
 *
 * `attach` insère la ligne `files` qui référence le blob : elle est appelée de façon
 * synchrone juste après la vérification, pour que le nettoyage ne puisse pas
 * supprimer le blob entre les deux.
 */
export async function storeBlob<T>(tmp: string, sha: string, size: number, attach: () => T): Promise<T> {
  if (db.prepare(`SELECT 1 FROM blobs WHERE sha256 = ?`).get(sha)) {
    const res = attach();
    await rm(tmp, { force: true });
    return res;
  }
  const dest = blobPath(sha);
  await mkdir(join(dest, ".."), { recursive: true });
  await rename(tmp, dest);
  db.prepare(`INSERT OR IGNORE INTO blobs (sha256, size, created_at) VALUES (?, ?, ?)`).run(sha, size, Date.now());
  return attach();
}

/**
 * Supprime les blobs que plus aucun fichier ne référence. Entièrement synchrone :
 * aucun envoi ne peut se terminer au milieu et réutiliser un blob en cours de suppression.
 */
export function deleteOrphanBlobs(): { count: number; bytes: number } {
  const orphans = db
    .prepare(`SELECT sha256, size FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.sha256 = b.sha256)`)
    .all() as { sha256: string; size: number }[];
  for (const { sha256 } of orphans) {
    db.prepare(`DELETE FROM blobs WHERE sha256 = ?`).run(sha256);
    rmSync(blobPath(sha256), { force: true });
  }
  return { count: orphans.length, bytes: orphans.reduce((n, b) => n + b.size, 0) };
}

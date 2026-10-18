import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { db } from "./db.js";
import { deleteOrphanBlobs, TMP_DIR, tmpPath } from "./storage.js";
import { formatBytes } from "./util.js";

const ORPHAN_TMP_MS = 3600_000;

/**
 * Nettoyage périodique :
 *  - fichiers expirés
 *  - envois abandonnés (et leurs fichiers temporaires)
 *  - connexions OAuth jamais terminées
 *  - blobs que plus aucun fichier n'utilise (c'est là que le disque est réellement libéré)
 */
export async function runCleanup(log: FastifyBaseLogger) {
  const now = Date.now();

  const expired = db
    .prepare(`DELETE FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?`)
    .run(now).changes;

  const stale = db
    .prepare(`SELECT id FROM uploads WHERE updated_at < ?`)
    .all(now - config.staleUploadMs) as { id: string }[];
  for (const { id } of stale) {
    db.prepare(`DELETE FROM uploads WHERE id = ?`).run(id);
    await rm(tmpPath(id), { force: true });
  }

  // fichiers temporaires sans envoi associé (crash, compte supprimé…) ; on laisse
  // ceux de moins d'une heure, qui peuvent être en cours de finalisation
  const live = new Set((db.prepare(`SELECT id FROM uploads`).all() as { id: string }[]).map(r => r.id));
  let orphanTmp = 0;
  for (const name of await readdir(TMP_DIR)) {
    if (live.has(name)) continue;
    const path = join(TMP_DIR, name);
    const s = await stat(path).catch(() => null);
    if (s && now - s.mtimeMs > ORPHAN_TMP_MS) {
      await rm(path, { force: true });
      orphanTmp++;
    }
  }

  db.prepare(`DELETE FROM login_requests WHERE created_at < ?`).run(now - 10 * 60_000);

  const blobs = deleteOrphanBlobs();

  if (expired || stale.length || orphanTmp || blobs.count) {
    log.info(
      `Nettoyage : ${expired} fichier(s) expiré(s), ${stale.length} envoi(s) abandonné(s), ` +
        `${orphanTmp} temporaire(s) orphelin(s), ${blobs.count} blob(s) supprimé(s) (${formatBytes(blobs.bytes)} libérés)`,
    );
  }
}

export function scheduleCleanup(log: FastifyBaseLogger, everyMs = 10 * 60_000) {
  const run = () => runCleanup(log).catch(e => log.error(e, "Échec du nettoyage"));
  void run();
  return setInterval(run, everyMs);
}

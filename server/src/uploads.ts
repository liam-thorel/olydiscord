import { createWriteStream } from "node:fs";
import { rm, truncate, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { config } from "./config.js";
import { db, type FileRow, type UploadRow } from "./db.js";
import { fileInfo, safeMime } from "./files.js";
import { assertCapacity, hashFile, storeBlob, tmpPath } from "./storage.js";
import { formatBytes, httpError, randomId, sanitizeName } from "./util.js";

const chunkCount = (up: Pick<UploadRow, "size" | "chunk_size">) => Math.ceil(up.size / up.chunk_size);

const receivedChunks = (id: string) =>
  (db.prepare(`SELECT idx FROM upload_chunks WHERE upload_id = ? ORDER BY idx`).all(id) as { idx: number }[]).map(
    r => r.idx,
  );

function getOwnedUpload(id: string, userId: string): UploadRow {
  const up = db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(id) as UploadRow | undefined;
  if (!up || up.owner_id !== userId) throw httpError(404, "Envoi introuvable ou expiré");
  return up;
}

const createSchema = z.object({
  name: z.string().min(1).max(500),
  size: z.number().int().nonnegative(),
  mime: z.string().max(200).optional(),
});

/**
 * Envoi en morceaux, reprenable :
 *   POST   /uploads                    → crée l'envoi, réserve la place
 *   PUT    /uploads/:id/chunks/:index  → envoie un morceau (en parallèle possible)
 *   GET    /uploads/:id                → morceaux déjà reçus (pour reprendre)
 *   POST   /uploads/:id/complete       → vérifie, déduplique, publie le fichier
 *   DELETE /uploads/:id                → annule
 */
export function registerUploadRoutes(app: FastifyInstance) {
  // Le corps des morceaux est lu en flux, jamais chargé en mémoire
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  app.post("/uploads", async req => {
    const user = requireUser(req);
    const body = createSchema.parse(req.body);
    if (body.size > config.maxFileSize) {
      throw httpError(413, `Fichier trop lourd : ${formatBytes(config.maxFileSize)} maximum.`);
    }
    await assertCapacity(user.id, body.size, true);

    const id = randomId(16);
    const now = Date.now();
    // fichier creux de la taille finale : chaque morceau s'écrit directement à sa place
    await writeFile(tmpPath(id), "");
    await truncate(tmpPath(id), body.size);
    db.prepare(
      `INSERT INTO uploads (id, owner_id, name, mime, size, chunk_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, user.id, sanitizeName(body.name), safeMime(body.mime), body.size, config.chunkSize, now, now);

    return { id, chunkSize: config.chunkSize, chunkCount: Math.ceil(body.size / config.chunkSize) };
  });

  app.get("/uploads/:id", async req => {
    const user = requireUser(req);
    const up = getOwnedUpload((req.params as { id: string }).id, user.id);
    return { id: up.id, size: up.size, chunkSize: up.chunk_size, chunkCount: chunkCount(up), received: receivedChunks(up.id) };
  });

  app.put("/uploads/:id/chunks/:index", { bodyLimit: config.chunkSize + 1024 }, async req => {
    const user = requireUser(req);
    const { id, index } = req.params as { id: string; index: string };
    const up = getOwnedUpload(id, user.id);
    const idx = Number(index);
    const count = chunkCount(up);
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) throw httpError(400, "Numéro de morceau invalide");
    if (!(req.body as Readable | undefined)?.pipe) throw httpError(415, "Content-Type attendu : application/octet-stream");

    const expected = idx === count - 1 ? up.size - idx * up.chunk_size : up.chunk_size;
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > expected) cb(httpError(400, "Morceau trop grand"));
        else cb(null, chunk);
      },
    });
    await pipeline(
      req.body as Readable,
      counter,
      createWriteStream(tmpPath(id), { flags: "r+", start: idx * up.chunk_size }),
    );
    if (received !== expected) throw httpError(400, `Morceau incomplet (${received}/${expected} octets)`);

    db.prepare(`INSERT OR IGNORE INTO upload_chunks (upload_id, idx) VALUES (?, ?)`).run(id, idx);
    db.prepare(`UPDATE uploads SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
    return { ok: true };
  });

  app.post("/uploads/:id/complete", async req => {
    const user = requireUser(req);
    const up = getOwnedUpload((req.params as { id: string }).id, user.id);
    const got = receivedChunks(up.id).length;
    const count = chunkCount(up);
    if (got !== count) throw httpError(409, `Il manque ${count - got} morceau(x) sur ${count}`);

    // retire l'envoi tout de suite : un second appel à /complete échouera au lieu de doubler le fichier
    db.prepare(`DELETE FROM uploads WHERE id = ?`).run(up.id);
    const tmp = tmpPath(up.id);
    const sha = await hashFile(tmp);

    const now = Date.now();
    const fileId = randomId();
    const row: FileRow = {
      id: fileId,
      owner_id: user.id,
      kind: "upload",
      name: up.name,
      mime: up.mime,
      size: up.size,
      sha256: sha,
      created_at: now,
      expires_at: now + config.fileTtlMs,
      downloads: 0,
    };
    await storeBlob(tmp, sha, up.size, () =>
      db
        .prepare(
          `INSERT INTO files (id, owner_id, kind, name, mime, size, sha256, created_at, expires_at) VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, ?)`,
        )
        .run(fileId, user.id, row.name, row.mime, row.size, sha, now, row.expires_at),
    );
    return fileInfo(row, user.username);
  });

  app.delete("/uploads/:id", async req => {
    const user = requireUser(req);
    const up = getOwnedUpload((req.params as { id: string }).id, user.id);
    db.prepare(`DELETE FROM uploads WHERE id = ?`).run(up.id);
    await rm(tmpPath(up.id), { force: true });
    return { ok: true };
  });
}

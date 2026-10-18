import type { FastifyInstance } from "fastify";
import { isAdmin, requireUser } from "./auth.js";
import { config } from "./config.js";
import { db, type FileRow } from "./db.js";
import { BLOBS_DIR, blobRelPath, userUsage } from "./storage.js";
import { httpError } from "./util.js";

/** Types affichés directement dans le navigateur ; tout le reste est forcé en téléchargement */
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|avif|apng)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|text\/plain|application\/pdf)$/;

export function safeMime(mime: string | undefined): string {
  const m = mime?.toLowerCase().trim();
  return m && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) ? m : "application/octet-stream";
}

export const fileUrl = (row: Pick<FileRow, "id" | "name">) =>
  `${config.PUBLIC_URL}/f/${row.id}/${encodeURIComponent(row.name)}`;

export function fileInfo(row: FileRow, ownerName?: string) {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    url: fileUrl(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    downloads: row.downloads,
    owner: { id: row.owner_id, username: ownerName ?? null },
  };
}

function getLiveFile(id: string) {
  const row = db
    .prepare(`SELECT f.*, u.username FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = ?`)
    .get(id) as (FileRow & { username: string }) | undefined;
  if (!row) throw httpError(404, "Fichier introuvable");
  if (row.expires_at !== null && row.expires_at <= Date.now()) throw httpError(410, "Ce fichier a expiré");
  return row;
}

export function registerFileRoutes(app: FastifyInstance) {
  // Téléchargement / lecture (public : l'identifiant n'est pas devinable).
  // Le suffixe /:name est décoratif, il rend les liens lisibles dans Discord.
  const serve = async (req: any, reply: any) => {
    const row = getLiveFile(req.params.id);
    const inline = INLINE_MIME.test(row.mime);

    const range = req.headers.range as string | undefined;
    if (req.method === "GET" && (!range || /^bytes=0-/.test(range))) {
      db.prepare(`UPDATE files SET downloads = downloads + 1 WHERE id = ?`).run(row.id);
    }

    reply
      .header("Content-Type", row.mime)
      .header(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      )
      .header("X-Content-Type-Options", "nosniff")
      // un fichier envoyé ne doit jamais pouvoir exécuter de script sur ce domaine
      .header("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header("Cache-Control", row.kind === "upload" ? "public, max-age=86400" : "public, max-age=31536000, immutable")
      .header("Access-Control-Allow-Origin", "*");
    return reply.sendFile(blobRelPath(row.sha256), BLOBS_DIR, { cacheControl: false, contentType: false });
  };
  app.get("/f/:id", serve);
  app.get("/f/:id/:name", serve);

  // Métadonnées publiques : le client s'en sert pour afficher le fichier comme une vraie pièce jointe
  app.get("/files/:id", async req => {
    const row = getLiveFile((req.params as { id: string }).id);
    return fileInfo(row, row.username);
  });

  app.get("/me", async req => {
    const user = requireUser(req);
    const profile = db.prepare(`SELECT avatar_file, banner_file, accent_color FROM profiles WHERE user_id = ?`).get(user.id) as
      | { avatar_file: string | null; banner_file: string | null; accent_color: number | null }
      | undefined;
    return {
      user,
      admin: isAdmin(user),
      storage: {
        used: userUsage(user.id),
        quota: config.userQuota,
        maxFileSize: config.maxFileSize,
        chunkSize: config.chunkSize,
        ttlDays: config.FILE_TTL_DAYS,
      },
      profile: {
        avatar: profile?.avatar_file ? `${config.PUBLIC_URL}/f/${profile.avatar_file}` : null,
        banner: profile?.banner_file ? `${config.PUBLIC_URL}/f/${profile.banner_file}` : null,
        accentColor: profile?.accent_color ?? null,
      },
    };
  });

  app.get("/me/files", async req => {
    const user = requireUser(req);
    const rows = db
      .prepare(
        `SELECT * FROM files WHERE owner_id = ? AND kind = 'upload' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC`,
      )
      .all(user.id, Date.now()) as unknown as FileRow[];
    return rows.map(r => fileInfo(r, user.username));
  });

  app.delete("/files/:id", async req => {
    const user = requireUser(req);
    const row = db.prepare(`SELECT owner_id FROM files WHERE id = ?`).get((req.params as { id: string }).id) as
      | { owner_id: string }
      | undefined;
    if (!row) throw httpError(404, "Fichier introuvable");
    if (row.owner_id !== user.id && !isAdmin(user)) throw httpError(403, "Ce fichier ne t'appartient pas");
    // le blob est supprimé au prochain nettoyage s'il n'est plus utilisé
    db.prepare(`DELETE FROM files WHERE id = ?`).run((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/files/:id/extend", async req => {
    const user = requireUser(req);
    const row = getLiveFile((req.params as { id: string }).id);
    if (row.owner_id !== user.id) throw httpError(403, "Ce fichier ne t'appartient pas");
    if (row.kind !== "upload") throw httpError(400, "Ce fichier n'expire pas");
    const expiresAt = Date.now() + config.fileTtlMs;
    db.prepare(`UPDATE files SET expires_at = ? WHERE id = ?`).run(expiresAt, row.id);
    return { expiresAt };
  });
}

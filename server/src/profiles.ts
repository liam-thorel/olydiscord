import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { config } from "./config.js";
import { db, type FileRow, transaction } from "./db.js";
import { assertCapacity, storeBlob, tmpPath } from "./storage.js";
import { httpError, randomId } from "./util.js";

export type ImageKind = Exclude<FileRow["kind"], "upload">;

/** Image de profil Oly : à qui elle appartient et dans quelle colonne elle est rangée */
export interface ImageTarget {
  kind: ImageKind;
  table: "profiles" | "guild_profiles";
  keyColumn: "user_id" | "guild_id";
  key: string;
  column: "avatar_file" | "banner_file" | "icon_file";
}

/** Type réel de l'image d'après ses premiers octets (on ne fait pas confiance au Content-Type) */
function detectImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const head = buf.subarray(0, 4).toString("latin1");
  return (
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || // PNG
    (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) || // JPEG
    head === "GIF8" ||
    (head === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP")
  );
}

export const fileUrlById = (id: string | null) => (id ? `${config.PUBLIC_URL}/f/${id}` : null);

/** Taille finale stockée : bannière de profil Discord en 5:2, bannière de serveur en 16:9 */
const OUTPUT_SIZE: Record<ImageKind, { width: number; height: number }> = {
  avatar: { width: 512, height: 512 },
  banner: { width: 1200, height: 480 },
  guild_icon: { width: 512, height: 512 },
  guild_banner: { width: 960, height: 540 },
};

/** Zone à garder, en pixels de l'image d'origine (?x=&y=&w=&h=). Absente = recadrage centré. */
const cropSchema = z
  .object({
    x: z.coerce.number().int().nonnegative(),
    y: z.coerce.number().int().nonnegative(),
    w: z.coerce.number().int().positive(),
    h: z.coerce.number().int().positive(),
  })
  .partial()
  .transform(c => (c.x !== undefined && c.y !== undefined && c.w && c.h ? { x: c.x, y: c.y, w: c.w, h: c.h } : null));

/**
 * Recadre puis redimensionne l'image en WebP. Les GIF/WebP animés restent animés
 * (sharp découpe chaque image de l'animation). Les APNG ne gardent que leur première image.
 */
async function processImage(
  input: Buffer,
  kind: ImageKind,
  crop: { x: number; y: number; w: number; h: number } | null,
): Promise<Buffer> {
  const meta = await sharp(input, { animated: true }).metadata().catch(() => {
    throw httpError(415, "Image illisible ou corrompue");
  });
  const width = meta.width!;
  const height = meta.pageHeight ?? meta.height!;
  const { width: outW, height: outH } = OUTPUT_SIZE[kind];

  let img = sharp(input, { animated: true });
  if (crop) {
    // on reste dans les limites de l'image même si le client envoie une zone qui déborde
    const left = Math.min(crop.x, width - 1);
    const top = Math.min(crop.y, height - 1);
    img = img.extract({
      left,
      top,
      width: Math.max(1, Math.min(crop.w, width - left)),
      height: Math.max(1, Math.min(crop.h, height - top)),
    });
  }
  return img
    .resize(outW, outH, { fit: "cover", position: "centre" })
    .webp({ quality: 85, effort: 4 })
    .toBuffer()
    .catch(() => {
      throw httpError(422, "Impossible de traiter cette image");
    });
}

const upsertSql = (t: ImageTarget) =>
  t.table === "guild_profiles"
    ? `INSERT INTO guild_profiles (guild_id, ${t.column}, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET ${t.column} = excluded.${t.column},
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    : `INSERT INTO profiles (user_id, ${t.column}, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET ${t.column} = excluded.${t.column}, updated_at = excluded.updated_at`;

/** Lit l'image envoyée (corps brut + ?x&y&w&h), la traite et la range à la place de l'ancienne */
export async function saveImage(req: FastifyRequest, userId: string, target: ImageTarget) {
  const input = req.body as Buffer | undefined;
  if (!Buffer.isBuffer(input)) throw httpError(415, "Envoie une image (GIF, WebP, PNG ou JPEG)");
  if (!detectImage(input)) throw httpError(415, "Format non reconnu : GIF, WebP, PNG ou JPEG uniquement");
  const crop = cropSchema.parse(req.query);

  const buf = await processImage(input, target.kind, crop);
  await assertCapacity(userId, buf.length, false);

  const sha = createHash("sha256").update(buf).digest("hex");
  const tmp = tmpPath(`profile-${randomId(16)}`);
  await writeFile(tmp, buf);

  const fileId = randomId();
  const now = Date.now();
  await storeBlob(tmp, sha, buf.length, () =>
    transaction(() => {
      const old = db
        .prepare(`SELECT ${target.column} AS file FROM ${target.table} WHERE ${target.keyColumn} = ?`)
        .get(target.key) as { file: string | null } | undefined;
      db.prepare(
        `INSERT INTO files (id, owner_id, kind, name, mime, size, sha256, created_at, expires_at) VALUES (?, ?, ?, ?, 'image/webp', ?, ?, ?, NULL)`,
      ).run(fileId, userId, target.kind, `${target.kind}.webp`, buf.length, sha, now);
      const params = target.table === "guild_profiles" ? [target.key, fileId, userId, now] : [target.key, fileId, now];
      db.prepare(upsertSql(target)).run(...params);
      if (old?.file) db.prepare(`DELETE FROM files WHERE id = ?`).run(old.file);
    }),
  );
  return { url: fileUrlById(fileId) };
}

export function clearImage(target: ImageTarget) {
  transaction(() => {
    const old = db
      .prepare(`SELECT ${target.column} AS file FROM ${target.table} WHERE ${target.keyColumn} = ?`)
      .get(target.key) as { file: string | null } | undefined;
    db.prepare(`UPDATE ${target.table} SET ${target.column} = NULL, updated_at = ? WHERE ${target.keyColumn} = ?`).run(
      Date.now(),
      target.key,
    );
    if (old?.file) db.prepare(`DELETE FROM files WHERE id = ?`).run(old.file);
  });
  return { ok: true };
}

export function registerProfileRoutes(app: FastifyInstance) {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: config.maxProfileImage }, (_req, body, done) =>
    done(null, body),
  );

  const userTarget = (userId: string, slot: "avatar" | "banner"): ImageTarget => ({
    kind: slot,
    table: "profiles",
    keyColumn: "user_id",
    key: userId,
    column: slot === "avatar" ? "avatar_file" : "banner_file",
  });

  for (const slot of ["avatar", "banner"] as const) {
    app.put(`/me/${slot}`, { bodyLimit: config.maxProfileImage }, async req => {
      const user = requireUser(req);
      return saveImage(req, user.id, userTarget(user.id, slot));
    });
    app.delete(`/me/${slot}`, async req => clearImage(userTarget(requireUser(req).id, slot)));
  }

  app.patch("/me/profile", async req => {
    const user = requireUser(req);
    const body = z.object({ accentColor: z.number().int().min(0).max(0xffffff).nullable() }).parse(req.body);
    db.prepare(
      `INSERT INTO profiles (user_id, accent_color, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET accent_color = excluded.accent_color, updated_at = excluded.updated_at`,
    ).run(user.id, body.accentColor, Date.now());
    return { ok: true };
  });

  // Tous les utilisateurs Oly et les serveurs personnalisés : le client garde ces listes en cache
  // et remplace avatars, bannières et icônes à la volée.
  app.get("/profiles", async (req, reply) => {
    requireUser(req);
    const users = db
      .prepare(
        `SELECT u.id, p.avatar_file, p.banner_file, p.accent_color
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id`,
      )
      .all() as { id: string; avatar_file: string | null; banner_file: string | null; accent_color: number | null }[];
    const guilds = db
      .prepare(`SELECT guild_id, icon_file, banner_file FROM guild_profiles WHERE icon_file IS NOT NULL OR banner_file IS NOT NULL`)
      .all() as { guild_id: string; icon_file: string | null; banner_file: string | null }[];
    reply.header("Cache-Control", "no-store");
    return {
      users: Object.fromEntries(
        users.map(r => [
          r.id,
          { avatar: fileUrlById(r.avatar_file), banner: fileUrlById(r.banner_file), accentColor: r.accent_color },
        ]),
      ),
      guilds: Object.fromEntries(
        guilds.map(g => [g.guild_id, { icon: fileUrlById(g.icon_file), banner: fileUrlById(g.banner_file) }]),
      ),
    };
  });
}

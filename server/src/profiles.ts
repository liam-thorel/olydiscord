import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { config } from "./config.js";
import { db, transaction } from "./db.js";
import { assertCapacity, storeBlob, tmpPath } from "./storage.js";
import { httpError, randomId } from "./util.js";

type Slot = "avatar" | "banner";

/** Type réel de l'image d'après ses premiers octets (on ne fait pas confiance au Content-Type) */
function detectImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: "image/png", ext: "png" }; // PNG et APNG animé
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return { mime: "image/gif", ext: "gif" };
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP")
    return { mime: "image/webp", ext: "webp" };
  return null;
}

const fileUrlById = (id: string | null) => (id ? `${config.PUBLIC_URL}/f/${id}` : null);

export function registerProfileRoutes(app: FastifyInstance) {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: config.maxProfileImage }, (_req, body, done) =>
    done(null, body),
  );

  const upload = (slot: Slot) => async (req: any) => {
    const user = requireUser(req);
    const buf = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(buf)) throw httpError(415, "Envoie une image (PNG, APNG, GIF, WebP ou JPEG)");
    const type = detectImage(buf);
    if (!type) throw httpError(415, "Format non reconnu : PNG, APNG, GIF, WebP ou JPEG uniquement");
    await assertCapacity(user.id, buf.length, false);

    const sha = createHash("sha256").update(buf).digest("hex");
    const tmp = tmpPath(`profile-${randomId(16)}`);
    await writeFile(tmp, buf);

    const fileId = randomId();
    const now = Date.now();
    const column = slot === "avatar" ? "avatar_file" : "banner_file";
    await storeBlob(tmp, sha, buf.length, () =>
      transaction(() => {
        const old = db.prepare(`SELECT ${column} AS file FROM profiles WHERE user_id = ?`).get(user.id) as
          | { file: string | null }
          | undefined;
        db.prepare(
          `INSERT INTO files (id, owner_id, kind, name, mime, size, sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(fileId, user.id, slot, `${slot}.${type.ext}`, type.mime, buf.length, sha, now);
        db.prepare(
          `INSERT INTO profiles (user_id, ${column}, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`,
        ).run(user.id, fileId, now);
        if (old?.file) db.prepare(`DELETE FROM files WHERE id = ?`).run(old.file);
      }),
    );
    return { url: fileUrlById(fileId) };
  };

  const remove = (slot: Slot) => async (req: any) => {
    const user = requireUser(req);
    const column = slot === "avatar" ? "avatar_file" : "banner_file";
    transaction(() => {
      const old = db.prepare(`SELECT ${column} AS file FROM profiles WHERE user_id = ?`).get(user.id) as
        | { file: string | null }
        | undefined;
      db.prepare(`UPDATE profiles SET ${column} = NULL, updated_at = ? WHERE user_id = ?`).run(Date.now(), user.id);
      if (old?.file) db.prepare(`DELETE FROM files WHERE id = ?`).run(old.file);
    });
    return { ok: true };
  };

  app.put("/me/avatar", { bodyLimit: config.maxProfileImage }, upload("avatar"));
  app.put("/me/banner", { bodyLimit: config.maxProfileImage }, upload("banner"));
  app.delete("/me/avatar", remove("avatar"));
  app.delete("/me/banner", remove("banner"));

  app.patch("/me/profile", async req => {
    const user = requireUser(req);
    const body = z.object({ accentColor: z.number().int().min(0).max(0xffffff).nullable() }).parse(req.body);
    db.prepare(
      `INSERT INTO profiles (user_id, accent_color, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET accent_color = excluded.accent_color, updated_at = excluded.updated_at`,
    ).run(user.id, body.accentColor, Date.now());
    return { ok: true };
  });

  // Tous les utilisateurs Oly et leur profil : le client garde cette liste en cache
  // et remplace avatar/bannière à la volée pour ces IDs.
  app.get("/profiles", async (req, reply) => {
    requireUser(req);
    const rows = db
      .prepare(
        `SELECT u.id, p.avatar_file, p.banner_file, p.accent_color
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id`,
      )
      .all() as { id: string; avatar_file: string | null; banner_file: string | null; accent_color: number | null }[];
    reply.header("Cache-Control", "no-store");
    return {
      users: Object.fromEntries(
        rows.map(r => [
          r.id,
          { avatar: fileUrlById(r.avatar_file), banner: fileUrlById(r.banner_file), accentColor: r.accent_color },
        ]),
      ),
    };
  });
}

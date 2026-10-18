import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { type AuthUser, isAdmin, requireUser, userFromToken } from "./auth.js";
import { config } from "./config.js";
import { db, transaction } from "./db.js";
import { assertGuildPermission, CREATE_GUILD_EXPRESSIONS, MANAGE_GUILD, MANAGE_GUILD_EXPRESSIONS } from "./guilds.js";
import { assertCapacity, storeBlob, tmpPath } from "./storage.js";
import { httpError, randomId } from "./util.js";

interface SoundRow {
  id: string;
  owner_id: string;
  guild_id: string | null;
  name: string;
  emoji: string | null;
  file_id: string;
  created_at: number;
}

const snowflake = z.string().regex(/^\d{17,20}$/, "Identifiant de serveur invalide");

/** Format audio d'après les premiers octets (on ne fait pas confiance au Content-Type) */
function detectAudio(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;
  const ascii = (start: number, end: number) => buf.subarray(start, end).toString("latin1");
  if (ascii(0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { mime: "audio/mpeg", ext: "mp3" };
  if (ascii(0, 4) === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { mime: "audio/wav", ext: "wav" };
  if (ascii(0, 4) === "fLaC") return { mime: "audio/flac", ext: "flac" };
  if (ascii(4, 8) === "ftyp") return { mime: "audio/mp4", ext: "m4a" };
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return { mime: "audio/webm", ext: "webm" };
  return null;
}

const soundJson = (s: SoundRow) => ({
  id: s.id,
  name: s.name,
  emoji: s.emoji,
  guildId: s.guild_id,
  ownerId: s.owner_id,
  url: `${config.PUBLIC_URL}/f/${s.file_id}`,
});

const getSound = (id: string) => db.prepare(`SELECT * FROM sounds WHERE id = ?`).get(id) as SoundRow | undefined;

const canAddGuildSound = (userId: string, guildId: string) =>
  assertGuildPermission(
    userId,
    guildId,
    CREATE_GUILD_EXPRESSIONS | MANAGE_GUILD_EXPRESSIONS | MANAGE_GUILD,
    "Il faut la permission « Créer des expressions » sur ce serveur pour y ajouter un son.",
  );

const addSchema = z.object({
  name: z.string().trim().min(1, "Donne un nom au son").max(32),
  emoji: z.string().trim().max(16).optional(),
  guildId: snowflake.optional(),
});

// ── Diffusion en direct ────────────────────────────────────────────────────

interface Client {
  socket: WebSocket;
  user: AuthUser | null;
  /** salon vocal où se trouve l'utilisateur (déclaré par son client) */
  channelId: string | null;
  plays: number[];
}

const clients = new Set<Client>();
const PLAY_WINDOW_MS = 5_000;
const MAX_PLAYS_PER_WINDOW = 3;

const send = (c: Client, msg: unknown) => {
  if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
};

const messageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("auth"), token: z.string().max(200) }),
  z.object({ t: z.literal("voice"), channelId: snowflake.nullable() }),
  z.object({ t: z.literal("play"), soundId: z.string().max(32), channelId: snowflake }),
]);

function handleMessage(c: Client, raw: string) {
  let parsed;
  try {
    parsed = messageSchema.safeParse(JSON.parse(raw));
  } catch {
    return;
  }
  if (!parsed.success) return;
  const msg = parsed.data;

  if (msg.t === "auth") {
    c.user = userFromToken(msg.token);
    if (!c.user) return c.socket.close(4001, "Jeton invalide");
    return send(c, { t: "ready" });
  }
  if (!c.user) return c.socket.close(4001, "Non authentifié");

  if (msg.t === "voice") {
    c.channelId = msg.channelId;
    return;
  }

  // msg.t === "play"
  const now = Date.now();
  c.plays = c.plays.filter(t => now - t < PLAY_WINDOW_MS);
  if (c.plays.length >= MAX_PLAYS_PER_WINDOW) return send(c, { t: "error", error: "Doucement avec le soundboard 🙂" });
  if (c.channelId !== msg.channelId) return send(c, { t: "error", error: "Rejoins le salon vocal pour y jouer un son." });

  const sound = getSound(msg.soundId);
  // un son perso n'est jouable que par son propriétaire ; un son de serveur par tout le monde
  if (!sound || (sound.guild_id === null && sound.owner_id !== c.user.id)) {
    return send(c, { t: "error", error: "Son introuvable" });
  }
  c.plays.push(now);

  const payload = { t: "play", sound: soundJson(sound), userId: c.user.id, channelId: msg.channelId };
  for (const other of clients) {
    if (other !== c && other.user && other.channelId === msg.channelId) send(other, payload);
  }
}

// Cloudflare coupe une connexion silencieuse au bout de 100 s
setInterval(() => {
  for (const c of clients) if (c.socket.readyState === c.socket.OPEN) c.socket.ping();
}, 30_000).unref();

export function registerSoundRoutes(app: FastifyInstance) {
  app.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: config.soundMaxSize }, (_req, body, done) =>
    done(null, body),
  );

  // Sons perso + sons des serveurs demandés (?guilds=id1,id2)
  app.get("/sounds", async req => {
    const user = requireUser(req);
    const guildIds = String((req.query as { guilds?: string }).guilds ?? "")
      .split(",")
      .filter(id => /^\d{17,20}$/.test(id))
      .slice(0, 200);
    const personal = db
      .prepare(`SELECT * FROM sounds WHERE owner_id = ? AND guild_id IS NULL ORDER BY created_at`)
      .all(user.id) as unknown as SoundRow[];
    const guildRows = guildIds.length
      ? (db
          .prepare(`SELECT * FROM sounds WHERE guild_id IN (${guildIds.map(() => "?").join(",")}) ORDER BY created_at`)
          .all(...guildIds) as unknown as SoundRow[])
      : [];
    const guilds: Record<string, ReturnType<typeof soundJson>[]> = {};
    for (const s of guildRows) (guilds[s.guild_id!] ??= []).push(soundJson(s));
    return { personal: personal.map(soundJson), guilds };
  });

  // Ajout d'un son : corps = fichier audio brut, ?name=&emoji=&guildId=
  app.post("/sounds", { bodyLimit: config.soundMaxSize }, async req => {
    const user = requireUser(req);
    const { name, emoji, guildId } = addSchema.parse(req.query);
    const buf = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(buf)) throw httpError(415, "Envoie un fichier audio (MP3, OGG, WAV, FLAC, M4A ou WebM)");
    const type = detectAudio(buf);
    if (!type) throw httpError(415, "Format audio non reconnu : MP3, OGG, WAV, FLAC, M4A ou WebM");

    const count = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { n: number }).n;
    if (guildId) {
      await canAddGuildSound(user.id, guildId);
      if (count(`SELECT COUNT(*) AS n FROM sounds WHERE guild_id = ?`, guildId) >= config.MAX_GUILD_SOUNDS) {
        throw httpError(409, `Ce serveur a déjà ${config.MAX_GUILD_SOUNDS} sons OLYDISCORD.`);
      }
    } else if (
      count(`SELECT COUNT(*) AS n FROM sounds WHERE owner_id = ? AND guild_id IS NULL`, user.id) >= config.MAX_PERSONAL_SOUNDS
    ) {
      throw httpError(409, `Tu as déjà ${config.MAX_PERSONAL_SOUNDS} sons perso.`);
    }
    await assertCapacity(user.id, buf.length, false);

    const sha = createHash("sha256").update(buf).digest("hex");
    const tmp = tmpPath(`sound-${randomId(16)}`);
    await writeFile(tmp, buf);
    const now = Date.now();
    const row: SoundRow = {
      id: randomId(),
      owner_id: user.id,
      guild_id: guildId ?? null,
      name,
      emoji: emoji || null,
      file_id: randomId(),
      created_at: now,
    };
    await storeBlob(tmp, sha, buf.length, () =>
      transaction(() => {
        db.prepare(
          `INSERT INTO files (id, owner_id, kind, name, mime, size, sha256, created_at, expires_at) VALUES (?, ?, 'sound', ?, ?, ?, ?, ?, NULL)`,
        ).run(row.file_id, user.id, `${name}.${type.ext}`, type.mime, buf.length, sha, now);
        db.prepare(
          `INSERT INTO sounds (id, owner_id, guild_id, name, emoji, file_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(row.id, row.owner_id, row.guild_id, row.name, row.emoji, row.file_id, now);
      }),
    );
    return soundJson(row);
  });

  app.delete("/sounds/:id", async req => {
    const user = requireUser(req);
    const sound = getSound((req.params as { id: string }).id);
    if (!sound) throw httpError(404, "Son introuvable");
    if (sound.owner_id !== user.id && !isAdmin(user)) {
      if (!sound.guild_id) throw httpError(403, "Ce son ne t'appartient pas");
      await assertGuildPermission(
        user.id,
        sound.guild_id,
        MANAGE_GUILD_EXPRESSIONS | MANAGE_GUILD,
        "Il faut la permission « Gérer les expressions » pour retirer ce son.",
      );
    }
    // supprimer le fichier supprime le son (ON DELETE CASCADE) ; le blob part au prochain nettoyage
    db.prepare(`DELETE FROM files WHERE id = ?`).run(sound.file_id);
    return { ok: true };
  });

  // Temps réel : le client s'authentifie dans le premier message (pas de jeton dans l'URL, elle finit dans les logs)
  app.get("/ws", { websocket: true }, socket => {
    const client: Client = { socket, user: null, channelId: null, plays: [] };
    clients.add(client);
    const authTimeout = setTimeout(() => !client.user && socket.close(4001, "Authentification attendue"), 10_000);
    socket.on("message", data => handleMessage(client, data.toString().slice(0, 2000)));
    socket.on("close", () => {
      clearTimeout(authTimeout);
      clients.delete(client);
    });
  });
}

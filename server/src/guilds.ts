import type { FastifyInstance } from "fastify";
import { getDiscordAccessToken, requireUser } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { clearImage, type ImageTarget, saveImage } from "./profiles.js";
import { httpError } from "./util.js";

const ADMINISTRATOR = 0x8n;
export const MANAGE_GUILD = 0x20n;
export const MANAGE_GUILD_EXPRESSIONS = 1n << 30n;
export const CREATE_GUILD_EXPRESSIONS = 1n << 43n;
const ALL_PERMISSIONS = ~0n;
const PERMISSION_CACHE_MS = 5 * 60_000;

/** userId → (guildId → permissions) ; /users/@me/guilds est limité en débit, on évite de l'appeler à chaque envoi */
const permissionCache = new Map<string, { at: number; guilds: Map<string, bigint> }>();

/**
 * Vérifie que l'utilisateur a au moins une des permissions `anyOf` sur le serveur
 * (propriétaire et administrateurs passent toujours).
 */
export async function assertGuildPermission(userId: string, guildId: string, anyOf: bigint, message: string) {
  let entry = permissionCache.get(userId);
  if (!entry || Date.now() - entry.at > PERMISSION_CACHE_MS) {
    const token = await getDiscordAccessToken(userId, "guilds");
    const reauth = () =>
      httpError(403, "Reconnecte-toi à OLYDISCORD pour autoriser la gestion de tes serveurs.", "REAUTH");
    if (!token) throw reauth();

    const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      db.prepare(`DELETE FROM discord_tokens WHERE user_id = ?`).run(userId);
      throw reauth();
    }
    if (!res.ok) throw httpError(502, "Discord n'a pas répondu, réessaie dans un instant.");

    const list = (await res.json()) as { id: string; owner: boolean; permissions: string }[];
    entry = {
      at: Date.now(),
      guilds: new Map(
        list.map(g => {
          const perms = BigInt(g.permissions);
          return [g.id, g.owner || (perms & ADMINISTRATOR) !== 0n ? ALL_PERMISSIONS : perms];
        }),
      ),
    };
    permissionCache.set(userId, entry);
  }
  if (((entry.guilds.get(guildId) ?? 0n) & anyOf) === 0n) throw httpError(403, message);
}

const assertCanManageGuild = (userId: string, guildId: string) =>
  assertGuildPermission(userId, guildId, MANAGE_GUILD, "Il faut la permission « Gérer le serveur » pour changer son apparence OLYDISCORD.");

const guildTarget = (guildId: string, slot: "icon" | "banner"): ImageTarget => ({
  kind: slot === "icon" ? "guild_icon" : "guild_banner",
  table: "guild_profiles",
  keyColumn: "guild_id",
  key: guildId,
  column: slot === "icon" ? "icon_file" : "banner_file",
});

const guildId = (req: { params: unknown }) => {
  const { guildId } = req.params as { guildId: string };
  if (!/^\d{17,20}$/.test(guildId)) throw httpError(400, "Identifiant de serveur invalide");
  return guildId;
};

/** Icône et bannière Oly d'un serveur : modifiables par ceux qui peuvent gérer le serveur sur Discord */
export function registerGuildRoutes(app: FastifyInstance) {
  for (const slot of ["icon", "banner"] as const) {
    app.put(`/guilds/:guildId/${slot}`, { bodyLimit: config.maxProfileImage }, async req => {
      const user = requireUser(req);
      const id = guildId(req);
      await assertCanManageGuild(user.id, id);
      return saveImage(req, user.id, guildTarget(id, slot));
    });

    app.delete(`/guilds/:guildId/${slot}`, async req => {
      const user = requireUser(req);
      const id = guildId(req);
      await assertCanManageGuild(user.id, id);
      return clearImage(guildTarget(id, slot));
    });
  }
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { httpError, randomId, randomToken, sha256 } from "./util.js";

export interface AuthUser {
  id: string;
  username: string;
}

const LOGIN_TTL_MS = 10 * 60_000;
const redirectUri = `${config.PUBLIC_URL}/auth/callback`;

/** Utilisateur du jeton « Authorization: Bearer … », ou null */
export function getUser(req: FastifyRequest): AuthUser | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const hash = sha256(header.slice(7).trim());
  const row = db
    .prepare(
      `SELECT u.id, u.username, t.last_used_at FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ?`,
    )
    .get(hash) as (AuthUser & { last_used_at: number }) | undefined;
  if (!row) return null;
  // évite une écriture à chaque requête
  if (Date.now() - row.last_used_at > 3600_000) {
    db.prepare(`UPDATE tokens SET last_used_at = ? WHERE hash = ?`).run(Date.now(), hash);
  }
  return { id: row.id, username: row.username };
}

export function requireUser(req: FastifyRequest): AuthUser {
  const user = getUser(req);
  if (!user) throw httpError(401, "Non connecté à OLYDISCORD");
  return user;
}

export const isAdmin = (user: AuthUser) => config.ADMIN_USER_IDS.has(user.id);

const page = (title: string, text: string) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#1e1f22;color:#f2f3f5;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#2b2d31;padding:32px 40px;border-radius:12px;max-width:420px;text-align:center}h1{margin-top:0;font-size:22px}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function registerAuthRoutes(app: FastifyInstance) {
  // 1. Le client démarre une connexion et ouvre l'URL renvoyée dans le navigateur
  app.post("/auth/start", async () => {
    const id = randomToken();
    const state = randomToken();
    db.prepare(`INSERT INTO login_requests (id, state, created_at) VALUES (?, ?, ?)`).run(id, state, Date.now());

    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", config.DISCORD_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "none");
    return { loginId: id, url: url.toString(), expiresIn: LOGIN_TTL_MS / 1000 };
  });

  // 2. Discord redirige ici après autorisation
  app.get("/auth/callback", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    const { code, state } = req.query as { code?: string; state?: string };
    const login = state
      ? (db.prepare(`SELECT id, created_at FROM login_requests WHERE state = ?`).get(state) as
          | { id: string; created_at: number }
          | undefined)
      : undefined;
    if (!code || !login || Date.now() - login.created_at > LOGIN_TTL_MS) {
      return reply.code(400).send(page("Lien expiré", "Relance la connexion depuis les réglages OLYDISCORD."));
    }

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.DISCORD_CLIENT_ID,
        client_secret: config.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      req.log.error({ body: await tokenRes.text() }, "Échec de l'échange du code OAuth2");
      return reply.code(502).send(page("Erreur", "Discord a refusé la connexion, réessaie."));
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!meRes.ok) return reply.code(502).send(page("Erreur", "Impossible de lire ton profil Discord."));
    const me = (await meRes.json()) as { id: string; username: string; global_name?: string | null };

    if (config.ALLOWED_USER_IDS.size && !config.ALLOWED_USER_IDS.has(me.id)) {
      db.prepare(`DELETE FROM login_requests WHERE id = ?`).run(login.id);
      return reply.code(403).send(page("Accès refusé", "Ce serveur OLYDISCORD est réservé à des membres invités."));
    }

    const username = me.global_name || me.username;
    const token = randomToken();
    const now = Date.now();
    db.prepare(
      `INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username`,
    ).run(me.id, username, now);
    db.prepare(`INSERT INTO tokens (hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)`).run(
      sha256(token),
      me.id,
      now,
      now,
    );
    db.prepare(`UPDATE login_requests SET token = ?, user_id = ? WHERE id = ?`).run(token, me.id, login.id);

    return page("Connecté ✔", `Bienvenue sur OLYDISCORD, ${escapeHtml(username)} ! Tu peux fermer cet onglet et revenir sur Discord.`);
  });

  // 3. Le client récupère son jeton (une seule fois)
  app.get("/auth/poll/:loginId", async (req, reply) => {
    const { loginId } = req.params as { loginId: string };
    const row = db
      .prepare(`SELECT token, user_id, created_at FROM login_requests WHERE id = ?`)
      .get(loginId) as { token: string | null; user_id: string | null; created_at: number } | undefined;
    if (!row || Date.now() - row.created_at > LOGIN_TTL_MS) throw httpError(404, "Connexion expirée");
    if (!row.token) return reply.code(202).send({ pending: true });

    db.prepare(`DELETE FROM login_requests WHERE id = ?`).run(loginId);
    const user = db.prepare(`SELECT id, username FROM users WHERE id = ?`).get(row.user_id!) as unknown as AuthUser;
    return { token: row.token, user };
  });

  app.post("/auth/logout", async req => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      db.prepare(`DELETE FROM tokens WHERE hash = ?`).run(sha256(header.slice(7).trim()));
    }
    return { ok: true };
  });

  // Supprime le compte Oly et toutes ses données (les blobs orphelins partent au prochain nettoyage)
  app.delete("/me", async req => {
    const user = requireUser(req);
    const confirm = z.object({ confirm: z.literal(user.id) }).safeParse(req.body);
    if (!confirm.success) throw httpError(400, "Confirme avec ton ID Discord");
    db.prepare(`DELETE FROM users WHERE id = ?`).run(user.id);
    return { ok: true };
  });
}

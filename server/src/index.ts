import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyError } from "fastify";
import { z } from "zod";
import { isAdmin, registerAuthRoutes, requireUser } from "./auth.js";
import { scheduleCleanup } from "./cleanup.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { registerFileRoutes } from "./files.js";
import { registerGuildRoutes } from "./guilds.js";
import { registerProfileRoutes } from "./profiles.js";
import { registerSoundRoutes } from "./sounds.js";
import { BLOBS_DIR, diskStats, globalUsage } from "./storage.js";
import { registerUploadRoutes } from "./uploads.js";
import { httpError, HttpError } from "./util.js";

const app = Fastify({
  logger: { level: process.env.NODE_ENV === "production" ? "info" : "debug" },
  trustProxy: true, // derrière Cloudflare Tunnel
});

await app.register(fastifyCors, {
  // le client OLYDISCORD tourne dans la page discord.com
  origin: [/^https:\/\/(?:(?:canary|ptb)\.)?discord\.com$/],
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Authorization", "Content-Type"],
  maxAge: 86400,
});

await app.register(fastifyRateLimit, {
  max: 600,
  timeWindow: "1 minute",
  keyGenerator: req => (req.headers["cf-connecting-ip"] as string | undefined) ?? req.ip,
});

await app.register(fastifyStatic, { root: BLOBS_DIR, serve: false });
await app.register(fastifyWebsocket, { options: { maxPayload: 4096 } });

app.setErrorHandler((err: FastifyError | HttpError | z.ZodError, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
  if (err instanceof z.ZodError) return reply.code(400).send({ error: z.prettifyError(err) });
  if ("statusCode" in err && err.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: err.message });
  }
  req.log.error(err);
  return reply.code(500).send({ error: "Erreur interne du serveur OLYDISCORD" });
});

registerAuthRoutes(app);
registerUploadRoutes(app);
registerFileRoutes(app);
registerProfileRoutes(app);
registerGuildRoutes(app);
registerSoundRoutes(app);

app.get("/health", async () => ({ ok: true }));

app.get("/admin/stats", async req => {
  const user = requireUser(req);
  if (!isAdmin(user)) throw httpError(403, "Réservé aux administrateurs");
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    disk: await diskStats(),
    stored: globalUsage(),
    limits: { globalMax: config.globalMax, minFreeDisk: config.minFreeDisk, userQuota: config.userQuota },
    users: count(`SELECT COUNT(*) AS n FROM users`),
    files: count(`SELECT COUNT(*) AS n FROM files WHERE kind = 'upload'`),
    blobs: count(`SELECT COUNT(*) AS n FROM blobs`),
    pendingUploads: count(`SELECT COUNT(*) AS n FROM uploads`),
    topUsers: db
      .prepare(
        `SELECT u.id, u.username, COALESCE(SUM(f.size), 0) AS used, COUNT(f.id) AS files
         FROM users u LEFT JOIN files f ON f.owner_id = u.id AND f.kind = 'upload'
         GROUP BY u.id ORDER BY used DESC LIMIT 20`,
      )
      .all(),
  };
});

const cleanupTimer = scheduleCleanup(app.log);

const shutdown = async () => {
  clearInterval(cleanupTimer);
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });

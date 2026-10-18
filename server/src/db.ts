import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

mkdirSync(config.DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(config.DATA_DIR, "olydiscord.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,           -- ID Discord
    username    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  -- Jetons API du client (seul le hash SHA-256 est stocké)
  CREATE TABLE IF NOT EXISTS tokens (
    hash          TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL
  );

  -- Connexion en cours : le client attend (poll) que l'OAuth Discord se termine dans le navigateur
  CREATE TABLE IF NOT EXISTS login_requests (
    id          TEXT PRIMARY KEY,           -- secret connu du client seul
    state       TEXT NOT NULL UNIQUE,       -- passé à Discord
    token       TEXT,                       -- jeton en clair, effacé dès qu'il est récupéré
    user_id     TEXT,
    created_at  INTEGER NOT NULL
  );

  -- Contenu physique, dédupliqué par hash
  CREATE TABLE IF NOT EXISTS blobs (
    sha256      TEXT PRIMARY KEY,
    size        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,           -- identifiant public, non devinable
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,              -- 'upload' | 'avatar' | 'banner'
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL REFERENCES blobs(sha256),
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,                    -- NULL = n'expire pas (images de profil)
    downloads   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS files_owner ON files(owner_id, kind);
  CREATE INDEX IF NOT EXISTS files_expires ON files(expires_at);
  CREATE INDEX IF NOT EXISTS files_sha ON files(sha256);

  -- Envois en morceaux en cours
  CREATE TABLE IF NOT EXISTS uploads (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    chunk_size  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS upload_chunks (
    upload_id   TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    PRIMARY KEY (upload_id, idx)
  );

  CREATE TABLE IF NOT EXISTS profiles (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    avatar_file   TEXT REFERENCES files(id) ON DELETE SET NULL,
    banner_file   TEXT REFERENCES files(id) ON DELETE SET NULL,
    accent_color  INTEGER,
    updated_at    INTEGER NOT NULL
  );
`);

export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const res = fn();
    db.exec("COMMIT");
    return res;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface FileRow {
  id: string;
  owner_id: string;
  kind: "upload" | "avatar" | "banner";
  name: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: number;
  expires_at: number | null;
  downloads: number;
}

export interface UploadRow {
  id: string;
  owner_id: string;
  name: string;
  mime: string;
  size: number;
  chunk_size: number;
  created_at: number;
  updated_at: number;
}

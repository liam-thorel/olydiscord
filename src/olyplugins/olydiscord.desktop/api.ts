/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

export const SERVER = OLY_SERVER_URL;
export const logger = new Logger("OLYDISCORD", "#a78bfa");

// Le jeton reste dans l'IndexedDB locale : jamais dans les réglages Vencord, qui peuvent être synchronisés dans le cloud
const TOKEN_KEY = "olydiscord-token";

export interface OlyUser {
    id: string;
    username: string;
}

export interface OlyMe {
    user: OlyUser;
    admin: boolean;
    storage: { used: number; quota: number; maxFileSize: number; chunkSize: number; ttlDays: number; };
    profile: { avatar: string | null; banner: string | null; accentColor: number | null; };
}

export interface OlyFile {
    id: string;
    name: string;
    mime: string;
    size: number;
    url: string;
    createdAt: number;
    expiresAt: number | null;
    downloads: number;
    owner: { id: string; username: string | null; };
}

export interface OlyProfile {
    avatar: string | null;
    banner: string | null;
    accentColor: number | null;
}

export class OlyError extends Error {
    constructor(message: string, public status: number) {
        super(message);
    }
}

let token: string | null = null;
const authListeners = new Set<() => void>();

export const isLoggedIn = () => token !== null;

export function onAuthChange(fn: () => void) {
    authListeners.add(fn);
    return () => void authListeners.delete(fn);
}

async function setToken(value: string | null) {
    token = value;
    if (value) await DataStore.set(TOKEN_KEY, value);
    else await DataStore.del(TOKEN_KEY);
    authListeners.forEach(fn => fn());
}

export async function loadToken() {
    token = (await DataStore.get<string>(TOKEN_KEY)) ?? null;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (typeof init.body === "string") headers["Content-Type"] ??= "application/json";

    const res = await fetch(SERVER + path, { ...init, headers });
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    if (res.status === 401 && token) await setToken(null);
    if (!res.ok) throw new OlyError(data?.error ?? `Erreur ${res.status} du serveur OLYDISCORD`, res.status);
    return data as T;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Connexion : ouvre l'autorisation Discord dans le navigateur, puis attend que le serveur
 * ait reçu le retour OAuth. Le token Discord du client n'est jamais envoyé au serveur.
 */
export async function login(signal?: AbortSignal): Promise<OlyUser> {
    const { loginId, url, expiresIn } = await api<{ loginId: string; url: string; expiresIn: number; }>("/auth/start", { method: "POST" });
    VencordNative.native.openExternal(url);

    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
        await sleep(2000);
        if (signal?.aborted) throw new OlyError("Connexion annulée", 0);
        const res = await fetch(`${SERVER}/auth/poll/${loginId}`);
        if (res.status === 202) continue;
        if (!res.ok) throw new OlyError("La connexion a expiré, réessaie.", res.status);
        const { token: newToken, user } = await res.json() as { token: string; user: OlyUser; };
        await setToken(newToken);
        return user;
    }
    throw new OlyError("La connexion a expiré, réessaie.", 408);
}

export async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => { });
    await setToken(null);
}

export const getMe = () => api<OlyMe>("/me");
export const getMyFiles = () => api<OlyFile[]>("/me/files");
export const deleteFile = (id: string) => api(`/files/${id}`, { method: "DELETE" });
export const extendFile = (id: string) => api<{ expiresAt: number; }>(`/files/${id}/extend`, { method: "POST" });

// ── Profils des utilisateurs Oly ─────────────────────────────────────────────

export let profiles: Record<string, OlyProfile> = {};

export async function refreshProfiles() {
    if (!token) {
        profiles = {};
        return;
    }
    try {
        profiles = (await api<{ users: Record<string, OlyProfile>; }>("/profiles")).users;
    } catch (e) {
        logger.warn("Impossible de récupérer les profils Oly", e);
    }
}

export const isOlyUser = (userId: string | undefined) => !!userId && userId in profiles;

export async function setProfileImage(slot: "avatar" | "banner", file: File | null) {
    if (file) {
        await api(`/me/${slot}`, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
    } else {
        await api(`/me/${slot}`, { method: "DELETE" });
    }
    await refreshProfiles();
}

// ── Fichiers ────────────────────────────────────────────────────────────────

const fileInfoCache = new Map<string, Promise<OlyFile>>();

/** Métadonnées publiques d'un fichier (mises en cache pour toute la session) */
export function getFileInfo(id: string): Promise<OlyFile> {
    let p = fileInfoCache.get(id);
    if (!p) {
        p = api<OlyFile>(`/files/${id}`);
        p.catch(() => setTimeout(() => fileInfoCache.delete(id), 60_000));
        fileInfoCache.set(id, p);
    }
    return p;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FILE_LINK = new RegExp(`${escapeRegex(SERVER)}/f/([A-Za-z0-9]{12})(?:/[^\\s<>]*)?`, "g");

/** IDs des fichiers Oly cités dans un message */
export function findFileLinks(content: string | undefined): string[] {
    if (!content) return [];
    return [...new Set(Array.from(content.matchAll(FILE_LINK), m => m[1]))];
}

/** Envoie un morceau avec XHR (fetch ne donne pas la progression de l'envoi) */
function putChunk(url: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = e => onProgress(e.loaded);
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) return resolve();
            let message = `Erreur ${xhr.status}`;
            try { message = JSON.parse(xhr.responseText).error ?? message; } catch { }
            reject(new OlyError(message, xhr.status));
        };
        xhr.onerror = () => reject(new OlyError("Connexion au serveur OLYDISCORD perdue", 0));
        xhr.onabort = () => reject(new OlyError("Envoi annulé", 0));
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(body);
    });
}

const PARALLEL_CHUNKS = 3;
const RETRIES = 3;

/** Envoi en morceaux, en parallèle, avec reprise automatique d'un morceau qui échoue */
export async function uploadFile(file: File, onProgress: (sent: number, total: number) => void, signal: AbortSignal): Promise<OlyFile> {
    const up = await api<{ id: string; chunkSize: number; chunkCount: number; }>("/uploads", {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || undefined }),
    });

    const progress = new Array<number>(up.chunkCount).fill(0);
    const report = () => onProgress(progress.reduce((a, b) => a + b, 0), file.size);

    // un morceau en échec définitif arrête aussi les autres
    const ctrl = new AbortController();
    signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    signal = ctrl.signal;

    let next = 0;
    const worker = async () => {
        while (next < up.chunkCount && !signal.aborted) {
            const i = next++;
            const blob = file.slice(i * up.chunkSize, (i + 1) * up.chunkSize);
            for (let attempt = 1; ; attempt++) {
                try {
                    await putChunk(`${SERVER}/uploads/${up.id}/chunks/${i}`, blob, loaded => {
                        progress[i] = loaded;
                        report();
                    }, signal);
                    progress[i] = blob.size;
                    report();
                    break;
                } catch (e) {
                    progress[i] = 0;
                    const retryable = e instanceof OlyError && (e.status === 0 || e.status >= 500);
                    if (signal.aborted || !retryable || attempt >= RETRIES) throw e;
                    await sleep(1000 * attempt);
                }
            }
        }
    };

    try {
        await Promise.all(Array.from({ length: Math.min(PARALLEL_CHUNKS, up.chunkCount) }, worker));
        return await api<OlyFile>(`/uploads/${up.id}/complete`, { method: "POST" });
    } catch (e) {
        ctrl.abort();
        api(`/uploads/${up.id}`, { method: "DELETE" }).catch(() => { });
        throw e;
    }
}

export function formatBytes(n: number): string {
    const units = ["o", "Ko", "Mo", "Go", "To"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1).replace(".", ",")} ${units[i]}`;
}

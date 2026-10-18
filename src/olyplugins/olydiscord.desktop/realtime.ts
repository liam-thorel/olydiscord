/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MediaEngineStore, SelectedChannelStore, showToast } from "@webpack/common";

import { getToken, logger, type OlySound, SERVER } from "./api";

/**
 * Connexion temps réel au serveur Oly, pour le soundboard :
 *  - on lui indique le salon vocal où l'on est ;
 *  - quand un utilisateur Oly du même salon joue un son, le serveur nous le relaie et on le joue ici.
 * Les utilisateurs sans OLYDISCORD n'entendent rien : le son ne passe pas par la voix Discord.
 */

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 2000;
let wanted = false;
let getVolume = () => 0.6;

const currentVoiceChannel = () => SelectedChannelStore.getVoiceChannelId() ?? null;
const isDeafened = () => (MediaEngineStore as any).isSelfDeaf?.() === true;

function send(msg: unknown) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/** Lecture locale d'un son (ignorée si on s'est mis en sourdine) */
export function playLocally(sound: Pick<OlySound, "url">) {
    if (isDeafened()) return;
    const audio = new Audio(sound.url);
    audio.volume = Math.min(1, Math.max(0, getVolume()));
    audio.play().catch(e => logger.warn("Lecture du son impossible", e));
}

/** Joue un son pour soi et pour les utilisateurs Oly du salon vocal */
export function playSound(sound: OlySound) {
    playLocally(sound);
    const channelId = currentVoiceChannel();
    if (!channelId) {
        showToast({ text: "Aperçu seulement : rejoins un salon vocal pour que les autres utilisateurs Oly l'entendent." });
        return;
    }
    if (socket?.readyState !== WebSocket.OPEN) {
        showToast({ text: "Pas connecté au serveur OLYDISCORD : les autres n'entendront pas ce son.", variant: "critical" });
        return;
    }
    send({ t: "play", soundId: sound.id, channelId });
}

/** À appeler quand on rejoint ou quitte un salon vocal */
export function reportVoiceChannel(channelId: string | null = currentVoiceChannel()) {
    send({ t: "voice", channelId });
}

function onMessage(raw: string) {
    let msg: any;
    try {
        msg = JSON.parse(raw);
    } catch {
        return;
    }
    if (msg.t === "ready") {
        retryDelay = 2000;
        reportVoiceChannel();
    } else if (msg.t === "play" && msg.channelId === currentVoiceChannel()) {
        playLocally(msg.sound);
    } else if (msg.t === "error") {
        showToast({ text: msg.error, variant: "critical" });
    }
}

function connect() {
    const token = getToken();
    if (!wanted || !token || socket) return;
    const ws = new WebSocket(SERVER.replace(/^http/, "ws") + "/ws");
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", token }));
    ws.onmessage = e => onMessage(String(e.data));
    ws.onclose = e => {
        // ancienne connexion fermée volontairement (redémarrage) : elle ne doit pas toucher à la nouvelle
        if (socket !== ws) return;
        socket = null;
        if (!wanted) return;
        // jeton refusé : inutile d'insister tant qu'on ne s'est pas reconnecté
        if (e.code === 4001) return;
        reconnectTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60_000);
    };
}

/** Démarre (ou redémarre, après une connexion/déconnexion Oly) la liaison temps réel */
export function startRealtime(volume: () => number) {
    getVolume = volume;
    wanted = true;
    stopSocket();
    connect();
}

function stopSocket() {
    clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
}

export function stopRealtime() {
    wanted = false;
    stopSocket();
}

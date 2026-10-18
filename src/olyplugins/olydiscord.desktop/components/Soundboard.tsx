/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import type { RenderModalProps } from "@vencord/discord-types";
import {
    ChannelStore, GuildStore, Modal, openModal, PermissionsBits, PermissionStore, SelectedChannelStore,
    SelectedGuildStore, showToast, useEffect, useRef, UserStore, useState, useStateFromStores,
} from "@webpack/common";

import { addSound, deleteSound, getSounds, type OlySound } from "../api";
import { useOlyAuth, withReauth } from "../profileImage";
import { playLocally, playSound } from "../realtime";

const MAX_DURATION_S = 20;
const fail = (e: any) => showToast({ text: e?.message ?? "Erreur OLYDISCORD", variant: "critical" });

/** Durée d'un fichier audio, lue par le navigateur avant l'envoi */
function audioDuration(file: File): Promise<number> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const audio = new Audio();
        audio.preload = "metadata";
        audio.onloadedmetadata = () => {
            URL.revokeObjectURL(url);
            resolve(audio.duration);
        };
        audio.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Ce fichier audio n'est pas lisible"));
        };
        audio.src = url;
    });
}

function SoundGrid({ title, sounds, canDelete, onDeleted }: {
    title: string;
    sounds: OlySound[];
    canDelete(s: OlySound): boolean;
    onDeleted(): void;
}) {
    return (
        <section className="oly-sb-section">
            <h3 className="oly-section-heading">{title}</h3>
            {sounds.length === 0
                ? <p className="oly-muted">Aucun son pour l'instant.</p>
                : <div className="oly-sb-grid">
                    {sounds.map(s => (
                        <div key={s.id} className="oly-sb-sound">
                            <button className="oly-sb-play" title={`Jouer « ${s.name} »`} onClick={() => playSound(s)}>
                                <span className="oly-sb-emoji">{s.emoji || "🔊"}</span>
                                <span className="oly-ellipsis">{s.name}</span>
                            </button>
                            <button className="oly-sb-icon" title="Écouter (pour toi seulement)" onClick={() => playLocally(s)}>▶</button>
                            {canDelete(s) && (
                                <button
                                    className="oly-sb-icon"
                                    title="Supprimer"
                                    onClick={() => withReauth(() => deleteSound(s.id)).then(onDeleted, fail)}
                                >
                                    ✕
                                </button>
                            )}
                        </div>
                    ))}
                </div>}
        </section>
    );
}

function AddSoundForm({ guild, onAdded }: { guild: { id: string; name: string; } | null; onAdded(): void; }) {
    const fileInput = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [name, setName] = useState("");
    const [emoji, setEmoji] = useState("");
    const [target, setTarget] = useState<"me" | "guild">("me");
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        if (!file || !name.trim()) return;
        setBusy(true);
        try {
            const duration = await audioDuration(file);
            if (duration > MAX_DURATION_S) throw new Error(`Son trop long : ${MAX_DURATION_S} secondes maximum`);
            await withReauth(() => addSound(file, name.trim(), emoji.trim(), target === "guild" && guild ? guild.id : null));
            showToast({ text: `« ${name.trim()} » ajouté au soundboard`, variant: "success" });
            setFile(null);
            setName("");
            setEmoji("");
            onAdded();
        } catch (e) {
            fail(e);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="oly-sb-section oly-sb-add">
            <h3 className="oly-section-heading">Ajouter un son</h3>
            <div className="oly-row">
                <Button size="small" variant="secondary" onClick={() => fileInput.current?.click()}>
                    {file ? "Changer de fichier" : "Choisir un fichier audio"}
                </Button>
                <span className="oly-muted oly-ellipsis">{file?.name ?? `MP3, OGG, WAV… ${MAX_DURATION_S} s max`}</span>
            </div>
            {file && <>
                <div className="oly-row">
                    <input className="oly-input oly-input-emoji" placeholder="🔊" value={emoji} maxLength={8} onChange={e => setEmoji(e.currentTarget.value)} />
                    <input className="oly-input oly-grow" placeholder="Nom du son" value={name} maxLength={32} onChange={e => setName(e.currentTarget.value)} />
                </div>
                {guild && (
                    <select className="oly-input" value={target} onChange={e => setTarget(e.currentTarget.value as "me" | "guild")}>
                        <option value="me">Mes sons (utilisables sur tous les serveurs)</option>
                        <option value="guild">Sons de {guild.name} (pour tous les membres)</option>
                    </select>
                )}
                <Button size="small" disabled={busy || !name.trim()} onClick={submit}>{busy ? "Envoi…" : "Ajouter"}</Button>
            </>}
            <input
                ref={fileInput}
                type="file"
                accept="audio/*"
                hidden
                onChange={e => {
                    const f = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (!f) return;
                    setFile(f);
                    setName(n => n || f.name.replace(/\.[^.]+$/, "").slice(0, 32));
                }}
            />
        </section>
    );
}

function SoundboardModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const loggedIn = useOlyAuth();
    const voiceChannelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId() ?? null);
    // sons du serveur du salon vocal, sinon du serveur affiché
    const guildId = (voiceChannelId && ChannelStore.getChannel(voiceChannelId)?.guild_id) || SelectedGuildStore.getGuildId() || null;
    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const me = UserStore.getCurrentUser();

    const [personal, setPersonal] = useState<OlySound[]>([]);
    const [guildSounds, setGuildSounds] = useState<OlySound[]>([]);
    const reload = () => {
        if (!loggedIn) return;
        getSounds(guildId ? [guildId] : []).then(r => {
            setPersonal(r.personal);
            setGuildSounds(guildId ? r.guilds[guildId] ?? [] : []);
        }, fail);
    };
    useEffect(reload, [guildId, loggedIn]);

    const can = (perm: bigint | undefined) => !!guild && perm != null && PermissionStore.can(perm, guild as any);
    const canManage = can(PermissionsBits.MANAGE_GUILD_EXPRESSIONS) || can(PermissionsBits.MANAGE_GUILD);
    const canAdd = canManage || can(PermissionsBits.CREATE_GUILD_EXPRESSIONS);

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Soundboard OLYDISCORD"
            subtitle={voiceChannelId
                ? "Les sons sont entendus par les utilisateurs OLYDISCORD de ton salon vocal."
                : "Rejoins un salon vocal pour que les autres utilisateurs OLYDISCORD entendent tes sons."}
        >
            {loggedIn
                ? <div className="oly-sb">
                    <SoundGrid title="Mes sons" sounds={personal} canDelete={() => true} onDeleted={reload} />
                    {guild && (
                        <SoundGrid
                            title={`Sons de ${guild.name}`}
                            sounds={guildSounds}
                            canDelete={s => s.ownerId === me?.id || canManage}
                            onDeleted={reload}
                        />
                    )}
                    <AddSoundForm guild={canAdd && guild ? { id: guild.id, name: guild.name } : null} onAdded={reload} />
                </div>
                : <p className="oly-muted">Connecte-toi à OLYDISCORD (Paramètres → Vencord → Plugins → OLYDISCORD) pour utiliser le soundboard.</p>}
        </Modal>
    );
}

export const openSoundboard = () => openModal(props => <SoundboardModal modalProps={props} />);

/** Icône haut-parleur + ondes pour le bouton de la barre de saisie */
export function SoundboardIcon({ width = 20, height = 20 }: { width?: number | string; height?: number | string; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M3 9v6h4l5 4V5L7 9H3Z" />
            <path d="M16.5 12a4.5 4.5 0 0 0-2.25-3.9v7.8A4.5 4.5 0 0 0 16.5 12Z" />
            <path d="M14.25 3.2v2.06a7 7 0 0 1 0 13.48v2.06a9 9 0 0 0 0-17.6Z" />
        </svg>
    );
}

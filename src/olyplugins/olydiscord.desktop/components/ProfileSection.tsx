/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showToast, UserStore, useState } from "@webpack/common";
import type { ComponentType, ReactNode } from "react";

import { type ImageTarget, login } from "../api";
import { chooseImage, removeImage, useOlyAuth, useOlyGuildProfile, useOlyProfile } from "../profileImage";

/** Composant de section de l'éditeur de profil de Discord (récupéré par patch) */
export type DiscordSection = ComponentType<{ heading: ReactNode; disabled?: boolean; children?: ReactNode; }>;
/** Champ (titre + description) de la page « Profil du serveur » (récupéré par patch) */
export type DiscordField = ComponentType<{ label: ReactNode; description?: ReactNode; disabled?: boolean; children?: ReactNode; }>;

const FallbackSection: DiscordSection = ({ heading, children }) => (
    <div className="oly-section-fallback">
        <div className="oly-section-heading">{heading}</div>
        {children}
    </div>
);

const FallbackField: DiscordField = ({ label, description, children }) => (
    <div className="oly-section-fallback">
        <div className="oly-section-heading">{label}</div>
        {description && <div className="oly-muted">{description}</div>}
        {children}
    </div>
);

/** shape : forme de l'aperçu (rond pour une PP, arrondi pour une icône de serveur, large pour une bannière) */
function Tile({ target, label, shape, url, disabled }: {
    target: ImageTarget;
    label: string;
    shape: "circle" | "rounded" | "wide";
    url: string | null | undefined;
    disabled?: boolean;
}) {
    return (
        <div className={`oly-tile oly-tile-${shape}`}>
            <button
                className="oly-tile-button"
                disabled={disabled}
                aria-label={url ? `Modifier : ${label}` : `Ajouter : ${label}`}
                onClick={() => chooseImage(target)}
            >
                {url
                    ? <div className="oly-tile-preview" style={{ backgroundImage: `url(${url})` }} />
                    : <div className="oly-tile-add">+</div>}
                <div className="oly-tile-hover">{url ? "Modifier" : "Ajouter"}</div>
            </button>
            {url && !disabled && (
                <button className="oly-tile-remove" aria-label={`Retirer : ${label}`} onClick={() => removeImage(target)}>
                    ✕
                </button>
            )}
            <span className="oly-tile-label">{label}</span>
        </div>
    );
}

function LoginTile() {
    const [waiting, setWaiting] = useState(false);
    return (
        <div className="oly-tile oly-tile-circle">
            <button
                className="oly-tile-button"
                disabled={waiting}
                onClick={async () => {
                    setWaiting(true);
                    try {
                        const user = await login();
                        showToast({ text: `Connecté à OLYDISCORD en tant que ${user.username}`, variant: "success" });
                    } catch (e: any) {
                        showToast({ text: e?.message ?? "Connexion impossible", variant: "critical" });
                    } finally {
                        setWaiting(false);
                    }
                }}
            >
                <div className="oly-tile-add">{waiting ? "…" : "O"}</div>
            </button>
            <span className="oly-tile-label">{waiting ? "Autorise dans le navigateur…" : "Se connecter à OLYDISCORD"}</span>
        </div>
    );
}

/** Section ajoutée sous « Avatar et décoration » dans l'éditeur de profil de Discord */
export function OlyProfileSection({ user, guildId, disabled, Section = FallbackSection }: {
    user: { id: string; };
    guildId?: string | null;
    disabled?: boolean;
    Section?: DiscordSection;
}) {
    const loggedIn = useOlyAuth();
    const profile = useOlyProfile(user?.id);

    // le profil Oly est global : rien à afficher sur un profil de serveur ou celui d'un autre
    if (guildId || !user || user.id !== UserStore.getCurrentUser()?.id) return null;

    return (
        <Section heading="OLYDISCORD" disabled={disabled}>
            <div className="oly-tiles">
                {loggedIn
                    ? <>
                        <Tile target={{ type: "user", slot: "avatar" }} label="PP animée" shape="circle" url={profile?.avatar} disabled={disabled} />
                        <Tile target={{ type: "user", slot: "banner" }} label="Bannière animée" shape="wide" url={profile?.banner} disabled={disabled} />
                    </>
                    : <LoginTile />}
            </div>
        </Section>
    );
}

/** Section ajoutée sous « Icône » dans Paramètres du serveur → Profil du serveur */
export function OlyGuildSection({ profile, canManageGuild, Field = FallbackField }: {
    profile: { id: string; };
    canManageGuild?: boolean;
    Field?: DiscordField;
}) {
    const loggedIn = useOlyAuth();
    const guild = useOlyGuildProfile(profile?.id);
    if (!profile?.id) return null;
    const disabled = !canManageGuild;

    return (
        <Field
            label="OLYDISCORD"
            description="Icône et bannière animées vues par les membres qui utilisent OLYDISCORD, même sans boost."
            disabled={disabled}
        >
            <div className="oly-tiles">
                {loggedIn
                    ? <>
                        <Tile target={{ type: "guild", guildId: profile.id, slot: "icon" }} label="Icône animée" shape="rounded" url={guild?.icon} disabled={disabled} />
                        <Tile target={{ type: "guild", guildId: profile.id, slot: "banner" }} label="Bannière animée" shape="wide" url={guild?.banner} disabled={disabled} />
                    </>
                    : <LoginTile />}
            </div>
        </Field>
    );
}

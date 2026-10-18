/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openModal, showToast, useEffect, useReducer, useState } from "@webpack/common";

import { guildProfiles, type ImageTarget, isLoggedIn, login, OlyError, onAuthChange, onProfilesChange, profiles, setImage } from "./api";
import { type CropKind, CropModal } from "./components/CropModal";

export type ProfileSlot = "avatar" | "banner";

export function useOlyAuth() {
    const [loggedIn, setLoggedIn] = useState(isLoggedIn());
    useEffect(() => onAuthChange(() => setLoggedIn(isLoggedIn())), []);
    return loggedIn;
}

function useProfilesVersion() {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => onProfilesChange(rerender), []);
}

/** Profil Oly d'un utilisateur, mis à jour à chaque rafraîchissement */
export function useOlyProfile(userId: string | undefined) {
    useProfilesVersion();
    return userId ? profiles[userId] : undefined;
}

export function useOlyGuildProfile(guildId: string | undefined) {
    useProfilesVersion();
    return guildId ? guildProfiles[guildId] : undefined;
}

const cropKind = (t: ImageTarget): CropKind =>
    t.type === "user" ? t.slot : t.slot === "icon" ? "guildIcon" : "guildBanner";

const successText = (t: ImageTarget) =>
    t.type === "user"
        ? t.slot === "avatar" ? "PP OLYDISCORD mise à jour" : "Bannière OLYDISCORD mise à jour"
        : t.slot === "icon" ? "Icône OLYDISCORD du serveur mise à jour" : "Bannière OLYDISCORD du serveur mise à jour";

/**
 * Lance `action` ; si le serveur demande une nouvelle autorisation Discord (accès aux serveurs),
 * relance la connexion dans le navigateur puis réessaie une fois.
 */
export async function withReauth<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (e) {
        if (!(e instanceof OlyError) || e.code !== "REAUTH") throw e;
        showToast({ text: "Autorise OLYDISCORD à voir tes serveurs dans ton navigateur…", variant: "default" });
        await login();
        return action();
    }
}

/** Sélecteur de fichier puis fenêtre de recadrage ; le serveur fait le reste */
export function chooseImage(target: ImageTarget, onDone?: () => void) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/gif,image/png,image/webp,image/jpeg";
    input.addEventListener("change", () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        // la fenêtre de recadrage affiche elle-même les erreurs et reste ouverte dans ce cas
        openModal(props => (
            <CropModal
                modalProps={props}
                file={file}
                kind={cropKind(target)}
                onConfirm={async crop => {
                    await withReauth(() => setImage(target, file, crop));
                    showToast({ text: successText(target), variant: "success" });
                    onDone?.();
                }}
            />
        ));
    });
    input.click();
}

export async function removeImage(target: ImageTarget, onDone?: () => void) {
    try {
        await withReauth(() => setImage(target, null));
        showToast({ text: "Image retirée", variant: "success" });
        onDone?.();
    } catch (e: any) {
        showToast({ text: e?.message ?? "Erreur OLYDISCORD", variant: "critical" });
    }
}

export const chooseProfileImage = (slot: ProfileSlot, onDone?: () => void) => chooseImage({ type: "user", slot }, onDone);
export const removeProfileImage = (slot: ProfileSlot, onDone?: () => void) => removeImage({ type: "user", slot }, onDone);

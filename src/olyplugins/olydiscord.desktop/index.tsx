/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addProfileBadge, BadgePosition, type ProfileBadge, removeProfileBadge } from "@api/Badges";
import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { UploadIcon } from "@components/Icons";
import definePlugin, { OptionType } from "@utils/types";

import { findFileLinks, isOlyUser, loadToken, onAuthChange, profiles, refreshProfiles } from "./api";
import { OlyAttachment } from "./components/OlyAttachment";
import { SettingsPanel } from "./components/Settings";
import styles from "./styles.css?managed";
import { pickAndUpload } from "./upload";

const PROFILE_REFRESH_MS = 5 * 60_000;

const settings = definePluginSettings({
    account: {
        type: OptionType.COMPONENT,
        component: SettingsPanel,
    },
    showProfiles: {
        type: OptionType.BOOLEAN,
        description: "Afficher les PP et bannières OLYDISCORD des autres utilisateurs",
        default: true,
    },
    renderAttachments: {
        type: OptionType.BOOLEAN,
        description: "Afficher les fichiers envoyés via OLYDISCORD comme des pièces jointes",
        default: true,
    },
    showBadge: {
        type: OptionType.BOOLEAN,
        description: "Afficher un badge OLYDISCORD sur le profil des utilisateurs Oly",
        default: true,
    },
});

const BADGE_ICON = "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"11\" fill=\"#7c3aed\"/><text x=\"12\" y=\"16.5\" font-family=\"Arial,sans-serif\" font-size=\"13\" font-weight=\"bold\" fill=\"#fff\" text-anchor=\"middle\">O</text></svg>"
);

const badge: ProfileBadge = {
    id: "olydiscord",
    key: "olydiscord",
    description: "Utilisateur OLYDISCORD",
    iconSrc: BADGE_ICON,
    position: BadgePosition.END,
    shouldShow: ({ userId }) => settings.store.showBadge && isOlyUser(userId),
};

const UploadButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;
    return (
        <ChatBarButton tooltip="Envoyer un fichier lourd (OLYDISCORD)" onClick={pickAndUpload}>
            <UploadIcon width={20} height={20} />
        </ChatBarButton>
    );
};

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribeAuth: (() => void) | undefined;

export default definePlugin({
    name: "OLYDISCORD",
    description: "PP et bannière animées, gros fichiers via ton serveur : visibles par les autres utilisateurs d'OLYDISCORD",
    authors: [{ name: "Liam", id: 0n }],
    settings,
    managedStyle: styles,

    // Patchs vérifiés sur le code de Discord du 18/10/2026 (voir OLYDISCORD.md pour les revérifier)
    patches: [
        {
            find: "getUserAvatarURL:",
            replacement: [
                {
                    // avatar global : notre URL passe avant celle du CDN Discord
                    match: /return (\i\(\i,\i,\i,\i,\i\))\?\?(\i\((\i)\.id,\i\.discriminator,\i\.isProvisional,\i\))/,
                    replace: "return $self.getAvatarUrl($3)??$1??$2",
                },
                {
                    // avatar spécifique à un serveur : ignoré pour un utilisateur Oly, pour retomber sur l'avatar Oly
                    match: /(let\{userId:(\i),avatar:(\i),guildId:\i\}=\i.{0,80}?return )null==\3\?null:/,
                    replace: "$1null==$3||$self.hasOlyAvatar($2)?null:",
                },
            ],
        },
        {
            // même point d'accroche que le plugin USRBG (les deux ne peuvent pas être actifs ensemble)
            find: ':"SHOULD_LOAD");',
            replacement: {
                match: /\i(?:\?)?.getPreviewBanner\(\i,\i,\i\)(?=.{0,100}"COMPLETE")/,
                replace: "$self.getBannerUrl(arguments[0])||$&",
            },
        },
    ],

    getAvatarUrl(user: { id?: string; } | undefined): string | null {
        if (!settings.store.showProfiles || !user?.id) return null;
        return profiles[user.id]?.avatar ?? null;
    },

    hasOlyAvatar(userId: string | undefined): boolean {
        return settings.store.showProfiles && !!userId && !!profiles[userId]?.avatar;
    },

    getBannerUrl({ displayProfile }: { displayProfile?: { userId?: string; }; }): string | null {
        if (!settings.store.showProfiles || !displayProfile?.userId) return null;
        return profiles[displayProfile.userId]?.banner ?? null;
    },

    chatBarButton: {
        icon: UploadIcon,
        render: UploadButton,
    },

    renderMessageAccessory({ message }) {
        if (!settings.store.renderAttachments) return null;
        const ids = findFileLinks(message?.content);
        if (!ids.length) return null;
        return (
            <div className="oly-attachments">
                {ids.map(id => <OlyAttachment key={id} id={id} />)}
            </div>
        );
    },

    async start() {
        addProfileBadge(badge);
        await loadToken();
        await refreshProfiles();
        unsubscribeAuth = onAuthChange(() => void refreshProfiles());
        refreshTimer = setInterval(refreshProfiles, PROFILE_REFRESH_MS);
    },

    stop() {
        removeProfileBadge(badge);
        clearInterval(refreshTimer);
        unsubscribeAuth?.();
    },
});

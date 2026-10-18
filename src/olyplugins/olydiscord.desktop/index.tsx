/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addProfileBadge, BadgePosition, type ProfileBadge, removeProfileBadge } from "@api/Badges";
import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { UploadIcon } from "@components/Icons";
import definePlugin, { OptionType } from "@utils/types";

import { findFileLinks, guildProfiles, isOlyUser, loadToken, onAuthChange, profiles, refreshProfiles } from "./api";
import { OlyAttachment } from "./components/OlyAttachment";
import { type DiscordField, type DiscordSection, OlyGuildSection, OlyProfileSection } from "./components/ProfileSection";
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
    animateGuildIcons: {
        type: OptionType.BOOLEAN,
        description: "Toujours animer les icônes et bannières GIF des serveurs (même non boostés)",
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

const plugin = definePlugin({
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
                {
                    // icône de serveur (liste des serveurs, en-têtes…) : icône Oly, sinon GIF Discord toujours animé
                    match: /(function \i\(\i\)\{let\{id:(\i),icon:(\i),size:\i,canAnimate:(\i)=!1,lossless:\i=!1\}=\i;)/,
                    replace: "$1{const olyIcon=$self.getGuildIconUrl($2);if(olyIcon)return olyIcon}$4=$self.animateGuildImage($4,$3);",
                },
                {
                    // bannière de serveur (en haut de la liste des salons)
                    match: /(function \i\(\i\)\{let \i,\{id:(\i),banner:(\i)\}=\i,(\i)=arguments\.length>1&&void 0!==arguments\[1\]&&arguments\[1\];)/,
                    replace: "$1{const olyBanner=$self.getGuildBannerUrl($2);if(olyBanner)return olyBanner}$4=$self.animateGuildImage($4,$3);",
                },
            ],
        },
        {
            // Paramètres du serveur → Profil du serveur : section OLYDISCORD sous « Icône »
            find: "onCustomBannerChange:",
            group: true,
            replacement: [
                {
                    // récupère le composant de champ (titre + description) de la section « Icône »
                    match: /function (\i)\((\i)\)\{(?=let\{profile:\i,canManageGuild:\i,onIconChange:\i\}=\i,.{0,120}?children:\(0,\i\.jsx\)\((\i\.\i),\{label:\i\.intl\.string\(\i\.t#{intl::FkQnxJ::raw}\))/,
                    replace: "function $1($2){$self.GuildField=$3;",
                },
                {
                    match: /(\(0,(\i)\.jsx\)\(\i,\{profile:(\i),canManageGuild:(\i),onIconChange:\i\}\))(,\(0,\i\.jsx\)\("div",\{className:\i\.\i\}\))/,
                    replace: "$1$5,(0,$2.jsx)($self.OlyGuildSection,{profile:$3,canManageGuild:$4})",
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
        {
            // éditeur de profil (Paramètres → Profils) : section OLYDISCORD sous « Avatar et décoration »
            find: "UserProfileModalV2EditingPanel",
            group: true,
            replacement: [
                {
                    // récupère le composant de section de Discord pour avoir le même rendu
                    match: /(?=function (\i)\(\i\)\{let\{heading:\i,children:\i,disabled:\i=!1,showNitroIcon:)/,
                    replace: "$self.Section=$1;",
                },
                {
                    match: /(\(0,(\i)\.jsx\)\(\i,\{user:(\i),guildId:(\i),disabled:([^,]{1,12}),avatarErrorMessage:\i,avatarDecorationErrorMessage:\i\}\))/,
                    replace: "$1,(0,$2.jsx)($self.OlyProfileSection,{user:$3,guildId:$4,disabled:$5})",
                },
            ],
        },
    ],

    Section: undefined as DiscordSection | undefined,

    OlyProfileSection: ErrorBoundary.wrap(
        (props: { user: { id: string; }; guildId?: string | null; disabled?: boolean; }) =>
            <OlyProfileSection {...props} Section={plugin.Section} />,
        { noop: true },
    ),

    GuildField: undefined as DiscordField | undefined,

    OlyGuildSection: ErrorBoundary.wrap(
        (props: { profile: { id: string; }; canManageGuild?: boolean; }) =>
            <OlyGuildSection {...props} Field={plugin.GuildField} />,
        { noop: true },
    ),

    getGuildIconUrl(guildId: string | undefined): string | null {
        if (!settings.store.showProfiles || !guildId) return null;
        return guildProfiles[guildId]?.icon ?? null;
    },

    getGuildBannerUrl(guildId: string | undefined): string | null {
        if (!settings.store.showProfiles || !guildId) return null;
        return guildProfiles[guildId]?.banner ?? null;
    },

    /** Une icône/bannière GIF (hash « a_ ») est toujours animée, même là où Discord ne l'anime qu'au survol */
    animateGuildImage(canAnimate: boolean, hash: string | null | undefined): boolean {
        return canAnimate || (settings.store.animateGuildIcons && !!hash?.startsWith("a_"));
    },

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

export default plugin;

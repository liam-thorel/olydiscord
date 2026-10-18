/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Patch } from "@utils/types";

/**
 * Patchs du code de Discord utilisés par le plugin.
 *
 * Fichier sans dépendance (types seulement) : scripts/olyCheckPatches.mjs l'importe tel quel pour
 * vérifier chaque jour qu'ils s'appliquent toujours au code actuel de Discord.
 * Dernière vérification manuelle : 18/10/2026.
 */
export const patches: Omit<Patch, "plugin">[] = [
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
];

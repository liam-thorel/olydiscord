/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

/**
 * Discord ralentit son affichage quand sa fenêtre n'est pas au premier plan : un stream regardé sur un
 * second écran pendant qu'on joue tombe à quelques images par seconde. Trois leviers, réglables séparément
 * pour trouver celui qui compte sur une machine donnée :
 *  - faire croire à Discord que sa fenêtre est toujours active ;
 *  - couper le bridage d'arrière-plan d'Electron (Discord ne le coupe que pour l'overlay de jeu) ;
 *  - options Chromium anti-ralentissement, appliquées au lancement de Discord (voir native.ts).
 */

const Native = VencordNative.pluginHelpers.StreamFluide as PluginNative<typeof import("./native")>;

const applyThrottling = () => Native.applyBackgroundThrottling().catch(() => { });

const settings = definePluginSettings({
    fakeFocus: {
        type: OptionType.BOOLEAN,
        description: "Discord se comporte comme s'il était toujours au premier plan (vidéo, animations). "
            + "Revers : les notifications du salon ouvert peuvent ne plus sonner pendant que tu joues.",
        default: true,
    },
    noBackgroundThrottling: {
        type: OptionType.BOOLEAN,
        description: "Ne pas ralentir Discord quand il est en arrière-plan",
        default: true,
        onChange: applyThrottling,
    },
    chromiumSwitches: {
        type: OptionType.BOOLEAN,
        description: "Options Chromium anti-ralentissement (prend effet au prochain lancement de Discord)",
        default: true,
        restartNeeded: true,
    },
});

let active = false;
let interceptorAdded = false;

/**
 * Discord apprend que sa fenêtre perd le focus par l'action WINDOW_FOCUS { focused: false } :
 * on la transforme en « toujours active ». (Le dispatcher ne permet pas de retirer un intercepteur :
 * il reste en place mais ne fait plus rien quand le plugin est désactivé.)
 */
function focusInterceptor(action: { type: string; focused?: boolean; }) {
    if (active && settings.store.fakeFocus && action.type === "WINDOW_FOCUS" && action.focused === false) {
        action.focused = true;
    }
    return false; // ne bloque jamais l'action
}

export default definePlugin({
    name: "StreamFluide",
    description: "Garde les streams et l'interface de Discord fluides quand Discord n'est pas la fenêtre active (jeu sur un autre écran)",
    authors: [{ name: "Liam", id: 0n }],
    settings,
    // les options Chromium ne s'appliquent qu'au lancement
    restartNeeded: true,

    start() {
        active = true;
        if (!interceptorAdded) {
            FluxDispatcher.addInterceptor(focusInterceptor);
            interceptorAdded = true;
        }
        applyThrottling();
    },

    stop() {
        active = false;
        applyThrottling();
    },
});

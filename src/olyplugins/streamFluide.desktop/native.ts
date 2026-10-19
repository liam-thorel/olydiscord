/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { app, BrowserWindow, type IpcMainInvokeEvent } from "electron";

/**
 * Processus principal d'Electron. Ce fichier est chargé au démarrage, avant que Discord ne crée sa fenêtre :
 * c'est le seul moment où l'on peut ajouter des options à Chromium.
 */

const settings = () => RendererSettings.store.plugins?.StreamFluide;

// Options Chromium qui empêchent de ralentir une fenêtre en arrière-plan ou partiellement cachée.
// Elles ne s'appliquent qu'au lancement : activer/désactiver l'option demande de redémarrer Discord.
const CHROMIUM_SWITCHES = [
    "disable-renderer-backgrounding", // garde la priorité normale du rendu quand la fenêtre n'est pas active
    "disable-background-timer-throttling", // ne bride pas les minuteries en arrière-plan
    "disable-backgrounding-occluded-windows", // ne bride pas une fenêtre que Windows croit cachée
];

if (settings()?.enabled && settings()?.chromiumSwitches !== false) {
    for (const s of CHROMIUM_SWITCHES) app.commandLine.appendSwitch(s);
}

const throttlingWanted = () => !(settings()?.enabled && settings()?.noBackgroundThrottling !== false);

// fenêtres créées plus tard (fenêtre principale, stream détaché…)
app.on("browser-window-created", (_, win) => {
    win.webContents.setBackgroundThrottling(throttlingWanted());
});

/** Appelé par le plugin quand on l'active/désactive ou qu'on change l'option, sans redémarrer */
export function applyBackgroundThrottling(_: IpcMainInvokeEvent) {
    const enabled = throttlingWanted();
    for (const win of BrowserWindow.getAllWindows()) win.webContents.setBackgroundThrottling(enabled);
    return enabled;
}

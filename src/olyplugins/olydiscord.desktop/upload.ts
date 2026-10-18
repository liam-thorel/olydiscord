/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { insertTextIntoChatInputBox } from "@utils/discord";
import { showToast } from "@webpack/common";

import { formatBytes, isLoggedIn, logger, uploadFile } from "./api";

/** Petit panneau de progression en bas à droite (DOM simple, indépendant du rendu de Discord) */
function createProgressPanel(fileName: string, onCancel: () => void) {
    let container = document.getElementById("oly-uploads");
    if (!container) {
        container = document.createElement("div");
        container.id = "oly-uploads";
        document.body.appendChild(container);
    }

    const row = document.createElement("div");
    row.className = "oly-upload";
    row.innerHTML = `
        <div class="oly-upload-head">
            <span class="oly-upload-name"></span>
            <button class="oly-upload-cancel" title="Annuler">✕</button>
        </div>
        <div class="oly-upload-bar"><div class="oly-upload-fill"></div></div>
        <div class="oly-upload-status">Préparation…</div>`;
    row.querySelector(".oly-upload-name")!.textContent = fileName;
    row.querySelector("button")!.addEventListener("click", onCancel);
    container.appendChild(row);

    const fill = row.querySelector<HTMLElement>(".oly-upload-fill")!;
    const status = row.querySelector<HTMLElement>(".oly-upload-status")!;
    const startedAt = Date.now();

    return {
        update(sent: number, total: number) {
            const pct = total ? (sent / total) * 100 : 100;
            fill.style.width = `${pct}%`;
            const elapsed = (Date.now() - startedAt) / 1000;
            const speed = elapsed > 0.5 ? sent / elapsed : 0;
            status.textContent = `${formatBytes(sent)} / ${formatBytes(total)}` + (speed ? ` · ${formatBytes(speed)}/s` : "");
        },
        finishing() {
            fill.style.width = "100%";
            status.textContent = "Vérification…";
        },
        remove() {
            row.remove();
            if (!container!.childElementCount) container!.remove();
        },
    };
}

export async function uploadAndInsert(files: File[]) {
    if (!isLoggedIn()) {
        showToast({ text: "Connecte-toi à OLYDISCORD dans les réglages du plugin", variant: "critical" });
        return;
    }

    const links: string[] = [];
    for (const file of files) {
        const ctrl = new AbortController();
        const panel = createProgressPanel(file.name, () => ctrl.abort());
        try {
            const result = await uploadFile(file, (sent, total) => {
                if (sent >= total) panel.finishing();
                else panel.update(sent, total);
            }, ctrl.signal);
            links.push(result.url);
        } catch (e: any) {
            if (!ctrl.signal.aborted) {
                logger.error("Échec de l'envoi", e);
                showToast({ text: `${file.name} : ${e?.message ?? "échec de l'envoi"}`, variant: "critical" });
            }
        } finally {
            panel.remove();
        }
    }

    if (links.length) {
        // le lien est inséré dans la zone de saisie : on peut ajouter un message avant d'envoyer
        insertTextIntoChatInputBox(links.join("\n") + " ");
        showToast({ text: links.length > 1 ? `${links.length} fichiers prêts à être envoyés` : "Fichier prêt à être envoyé", variant: "success" });
    }
}

export function pickAndUpload() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.addEventListener("change", () => {
        if (input.files?.length) void uploadAndInsert(Array.from(input.files));
        input.remove();
    });
    input.click();
}

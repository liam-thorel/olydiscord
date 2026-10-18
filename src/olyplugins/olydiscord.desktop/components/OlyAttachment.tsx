/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";

import { formatBytes, getFileInfo, OlyError, type OlyFile } from "../api";

const formatDate = (ms: number) => new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

function FileCard({ file }: { file: OlyFile; }) {
    return (
        <div className="oly-file-card">
            <div className="oly-file-icon">📦</div>
            <div className="oly-file-meta">
                <a className="oly-file-name" href={file.url} target="_blank" rel="noreferrer">{file.name}</a>
                <div className="oly-file-size">{formatBytes(file.size)}</div>
            </div>
            <a className="oly-file-download" href={file.url} target="_blank" rel="noreferrer" title="Télécharger">⬇</a>
        </div>
    );
}

function Media({ file }: { file: OlyFile; }) {
    const type = file.mime.split("/")[0];
    if (type === "image") return <img className="oly-media" src={file.url} alt={file.name} loading="lazy" />;
    // preload="metadata" : seule la durée/miniature est chargée, pas toute la vidéo
    if (type === "video") return <video className="oly-media" src={file.url} controls preload="metadata" />;
    if (type === "audio") {
        return (
            <div className="oly-audio">
                <FileCard file={file} />
                <audio src={file.url} controls preload="none" />
            </div>
        );
    }
    return <FileCard file={file} />;
}

/** Affiche un lien de fichier Oly comme une vraie pièce jointe */
export function OlyAttachment({ id }: { id: string; }) {
    const [file, setFile] = useState<OlyFile | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        getFileInfo(id).then(
            f => alive && setFile(f),
            (e: unknown) => alive && setError(e instanceof OlyError && e.status === 410 ? "Ce fichier a expiré" : "Fichier introuvable"),
        );
        return () => void (alive = false);
    }, [id]);

    if (error) return <div className="oly-attachment oly-attachment-gone">🗑 {error}</div>;
    if (!file) return <div className="oly-attachment oly-attachment-loading" />;

    return (
        <div className="oly-attachment">
            <Media file={file} />
            <div className="oly-attachment-footer">
                via OLYDISCORD{file.expiresAt ? ` · disponible jusqu'au ${formatDate(file.expiresAt)}` : ""}
            </div>
        </div>
    );
}

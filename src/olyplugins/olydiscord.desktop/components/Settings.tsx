/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { showToast, useEffect, useRef, UserStore,useState } from "@webpack/common";

import {
    deleteFile, extendFile, formatBytes, getMe, getMyFiles, isLoggedIn, login, logout,
type OlyFile, type OlyMe, onAuthChange, SERVER, setProfileImage,
} from "../api";

const fail = (e: any) => showToast({ text: e?.message ?? "Erreur OLYDISCORD", variant: "critical" });

function useAuth() {
    const [loggedIn, setLoggedIn] = useState(isLoggedIn());
    useEffect(() => onAuthChange(() => setLoggedIn(isLoggedIn())), []);
    return loggedIn;
}

function LoginPanel() {
    const [waiting, setWaiting] = useState<AbortController | null>(null);

    const start = async () => {
        const ctrl = new AbortController();
        setWaiting(ctrl);
        try {
            const user = await login(ctrl.signal);
            showToast({ text: `Connecté à OLYDISCORD en tant que ${user.username}`, variant: "success" });
        } catch (e) {
            if (!ctrl.signal.aborted) fail(e);
        } finally {
            setWaiting(null);
        }
    };

    return (
        <div className="oly-settings-section">
            <Paragraph>
                Connecte ton compte Discord au serveur OLYDISCORD ({new URL(SERVER).host}) pour avoir une PP et une bannière
                animées et envoyer des fichiers lourds. Seul ton identifiant Discord est partagé.
            </Paragraph>
            {waiting
                ? <div className="oly-row">
                    <Paragraph>Autorise OLYDISCORD dans ton navigateur…</Paragraph>
                    <Button variant="secondary" size="small" onClick={() => waiting.abort()}>Annuler</Button>
                </div>
                : <Button onClick={start}>Se connecter avec Discord</Button>}
        </div>
    );
}

function ProfileImage({ slot, url, onChange }: { slot: "avatar" | "banner"; url: string | null; onChange(): void; }) {
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);

    const apply = async (file: File | null) => {
        setBusy(true);
        try {
            await setProfileImage(slot, file);
            showToast({ text: file ? "Image mise à jour" : "Image retirée", variant: "success" });
            onChange();
        } catch (e) {
            fail(e);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="oly-profile-image">
            <div className={`oly-preview oly-preview-${slot}`} style={url ? { backgroundImage: `url(${url})` } : undefined} />
            <div className="oly-column">
                <strong>{slot === "avatar" ? "Photo de profil" : "Bannière"}</strong>
                <span className="oly-muted">GIF, APNG, WebP, PNG ou JPEG</span>
                <div className="oly-row">
                    <Button size="small" disabled={busy} onClick={() => input.current?.click()}>Changer</Button>
                    {url && <Button size="small" variant="secondary" disabled={busy} onClick={() => apply(null)}>Retirer</Button>}
                </div>
            </div>
            <input
                ref={input}
                type="file"
                accept="image/gif,image/png,image/apng,image/webp,image/jpeg"
                hidden
                onChange={e => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (file) void apply(file);
                }}
            />
        </div>
    );
}

function FileList({ files, onChange }: { files: OlyFile[]; onChange(): void; }) {
    if (!files.length) return <Paragraph className="oly-muted">Aucun fichier envoyé.</Paragraph>;
    return (
        <div className="oly-files">
            {files.map(f => (
                <div key={f.id} className="oly-file-row">
                    <div className="oly-column oly-grow">
                        <span className="oly-ellipsis">{f.name}</span>
                        <span className="oly-muted">
                            {formatBytes(f.size)} · {f.downloads} téléchargement(s)
                            {f.expiresAt && ` · expire le ${new Date(f.expiresAt).toLocaleDateString("fr-FR")}`}
                        </span>
                    </div>
                    <Button size="small" variant="secondary" onClick={() => copyWithToast(f.url, "Lien copié")}>Copier</Button>
                    <Button size="small" variant="secondary" onClick={() => extendFile(f.id).then(onChange, fail)}>Prolonger</Button>
                    <Button size="small" variant="dangerSecondary" onClick={() => deleteFile(f.id).then(onChange, fail)}>Supprimer</Button>
                </div>
            ))}
        </div>
    );
}

function AccountPanel() {
    const [me, setMe] = useState<OlyMe | null>(null);
    const [files, setFiles] = useState<OlyFile[]>([]);

    const reload = () => {
        getMe().then(setMe, fail);
        getMyFiles().then(setFiles, fail);
    };
    useEffect(reload, []);

    if (!me) return <Paragraph>Chargement…</Paragraph>;

    const { used, quota, maxFileSize, ttlDays } = me.storage;
    const pct = Math.min(100, (used / quota) * 100);
    const discordId = UserStore.getCurrentUser()?.id;

    return (
        <>
            <div className="oly-settings-section oly-row">
                <Paragraph className="oly-grow">Connecté en tant que <strong>{me.user.username}</strong></Paragraph>
                <Button size="small" variant="secondary" onClick={() => logout()}>Se déconnecter</Button>
            </div>
            {discordId && discordId !== me.user.id && (
                <Paragraph className="oly-warning">
                    ⚠ Ce compte Oly n'est pas celui connecté à Discord : ta PP Oly s'affichera sur l'autre compte.
                </Paragraph>
            )}

            <HeadingTertiary>Profil</HeadingTertiary>
            <div className="oly-settings-section">
                <ProfileImage slot="avatar" url={me.profile.avatar} onChange={reload} />
                <ProfileImage slot="banner" url={me.profile.banner} onChange={reload} />
                <Paragraph className="oly-muted">Visible uniquement par les autres utilisateurs d'OLYDISCORD.</Paragraph>
            </div>

            <HeadingTertiary>Stockage</HeadingTertiary>
            <div className="oly-settings-section">
                <div className="oly-quota"><div className="oly-quota-fill" style={{ width: `${pct}%` }} /></div>
                <Paragraph className="oly-muted">
                    {formatBytes(used)} utilisés sur {formatBytes(quota)} · {formatBytes(maxFileSize)} max par fichier ·
                    fichiers conservés {ttlDays} jours
                </Paragraph>
                <FileList files={files} onChange={reload} />
            </div>
        </>
    );
}

export function SettingsPanel() {
    const loggedIn = useAuth();
    return <div className="oly-settings">{loggedIn ? <AccountPanel /> : <LoginPanel />}</div>;
}

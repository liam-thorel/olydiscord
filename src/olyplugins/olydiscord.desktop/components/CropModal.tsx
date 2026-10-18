/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, showToast, useEffect, useMemo, useRef, useState } from "@webpack/common";

import type { CropRect } from "../api";

export type CropKind = "avatar" | "banner" | "guildIcon" | "guildBanner";

/** Cadre à l'écran : mêmes proportions que l'image finale stockée par le serveur */
const FRAME: Record<CropKind, { w: number; h: number; mask: "circle" | "rounded" | null; title: string; }> = {
    avatar: { w: 300, h: 300, mask: "circle", title: "Recadrer la photo de profil" },
    banner: { w: 500, h: 200, mask: null, title: "Recadrer la bannière" },
    guildIcon: { w: 300, h: 300, mask: "rounded", title: "Recadrer l'icône du serveur" },
    guildBanner: { w: 480, h: 270, mask: null, title: "Recadrer la bannière du serveur" },
};
const MAX_ZOOM = 8;

interface View {
    zoom: number;
    /** coin haut-gauche de l'image par rapport au cadre, en pixels écran */
    x: number;
    y: number;
}

interface Props {
    modalProps: RenderModalProps;
    file: File;
    kind: CropKind;
    onConfirm(crop: CropRect): Promise<void>;
}

export function CropModal({ modalProps, file, kind, onConfirm }: Props) {
    const frame = FRAME[kind];
    const url = useMemo(() => URL.createObjectURL(file), [file]);
    useEffect(() => () => URL.revokeObjectURL(url), [url]);

    const [natural, setNatural] = useState<{ w: number; h: number; } | null>(null);
    const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
    const [saving, setSaving] = useState(false);
    const frameRef = useRef<HTMLDivElement>(null);
    const drag = useRef<{ startX: number; startY: number; x: number; y: number; } | null>(null);

    // échelle à zoom 1 : l'image couvre juste le cadre
    const base = natural ? Math.max(frame.w / natural.w, frame.h / natural.h) : 1;
    const scale = base * view.zoom;

    /** Garde le cadre entièrement couvert par l'image */
    const clamp = (v: View): View => {
        if (!natural) return v;
        const s = base * v.zoom;
        return {
            zoom: v.zoom,
            x: Math.min(0, Math.max(frame.w - natural.w * s, v.x)),
            y: Math.min(0, Math.max(frame.h - natural.h * s, v.y)),
        };
    };

    /** Zoome en gardant fixe le point du cadre (cx, cy) */
    const zoomTo = (zoom: number, cx = frame.w / 2, cy = frame.h / 2) =>
        setView(v => {
            const z = Math.min(MAX_ZOOM, Math.max(1, zoom));
            const ratio = z / v.zoom;
            return clamp({ zoom: z, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio });
        });

    // la molette doit pouvoir appeler preventDefault (les écouteurs React sont passifs)
    useEffect(() => {
        const el = frameRef.current;
        if (!el || !natural) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            setView(v => {
                const z = Math.min(MAX_ZOOM, Math.max(1, v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
                const cx = e.clientX - rect.left;
                const cy = e.clientY - rect.top;
                const ratio = z / v.zoom;
                return clamp({ zoom: z, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio });
            });
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [natural]);

    const crop: CropRect | null = natural && {
        x: Math.round(-view.x / scale),
        y: Math.round(-view.y / scale),
        w: Math.round(frame.w / scale),
        h: Math.round(frame.h / scale),
    };

    const save = async () => {
        if (!crop) return;
        setSaving(true);
        try {
            await onConfirm(crop);
            modalProps.onClose();
        } catch (e: any) {
            showToast({ text: e?.message ?? "Impossible d'enregistrer l'image", variant: "critical" });
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            {...modalProps}
            size={frame.w > 400 ? "lg" : "md"}
            title={frame.title}
            subtitle="Fais glisser l'image pour la placer, zoome avec la molette ou le curseur."
            actions={[
                { text: "Annuler", variant: "secondary", onClick: modalProps.onClose },
                { text: "Enregistrer", variant: "primary", onClick: save, loading: saving, disabled: !crop || saving },
            ]}
        >
            <div className="oly-crop">
                <div
                    ref={frameRef}
                    className="oly-crop-frame"
                    style={{ width: frame.w, height: frame.h }}
                    onPointerDown={e => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        drag.current = { startX: e.clientX, startY: e.clientY, x: view.x, y: view.y };
                    }}
                    onPointerMove={e => {
                        const d = drag.current;
                        if (!d) return;
                        setView(v => clamp({ ...v, x: d.x + e.clientX - d.startX, y: d.y + e.clientY - d.startY }));
                    }}
                    onPointerUp={() => void (drag.current = null)}
                    onPointerCancel={() => void (drag.current = null)}
                >
                    <img
                        src={url}
                        alt=""
                        draggable={false}
                        onLoad={e => {
                            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                            const s = Math.max(frame.w / w, frame.h / h);
                            setNatural({ w, h });
                            // image centrée au départ
                            setView({ zoom: 1, x: (frame.w - w * s) / 2, y: (frame.h - h * s) / 2 });
                        }}
                        style={natural ? {
                            width: natural.w * scale,
                            height: natural.h * scale,
                            transform: `translate(${view.x}px, ${view.y}px)`,
                        } : { visibility: "hidden" }}
                    />
                    {frame.mask && <div className={`oly-crop-mask oly-crop-mask-${frame.mask}`} />}
                </div>
                <input
                    className="oly-crop-zoom"
                    type="range"
                    min={1}
                    max={MAX_ZOOM}
                    step={0.01}
                    value={view.zoom}
                    disabled={!natural}
                    onChange={e => zoomTo(Number(e.currentTarget.value))}
                />
            </div>
        </Modal>
    );
}

// MediaEditor — a Signal-style full-screen image editor shown after the user
// captures a photo or picks an image. It provides:
//   • Add more (queue several images into one send)
//   • Pen (freehand draw with a colour palette)
//   • Crop (drag a rectangle, then apply)
//   • Rotate (90° steps)
//   • Media quality (Standard / HD — controls JPEG re-encode size & quality)
//   • View once / View infinity toggle (disappearing media)
//   • Caption + Send
//
// All edits are baked onto an HTML canvas and the result is re-encoded to a
// JPEG File handed back to the composer, which uploads it like any attachment.

import { useCallback, useEffect, useRef, useState } from "react";
import {
    X,
    Plus,
    Pencil,
    Crop as CropIcon,
    RotateCw,
    Send,
    Check,
    Trash2,
    Timer,
} from "lucide-react";
import s from "./MediaEditor.module.css";

export interface MediaEditorResult {
    file: File;
    viewOnce: boolean;
    caption?: string;
}

interface MediaEditorProps {
    initialFiles: File[];
    onSend: (results: MediaEditorResult[]) => void;
    onClose: () => void;
}

type Tool = "none" | "pen" | "crop";

interface EditItem {
    id: string;
    /** Original bitmap, drawn fresh each render before strokes/crop. */
    img: HTMLImageElement | null;
    /** Source object URL (revoked on unmount). */
    url: string;
    /** Baked strokes — kept as a separate canvas layered over the image. */
    strokes: { color: string; width: number; points: { x: number; y: number }[] }[];
    rotation: number; // 0,90,180,270
    /** Crop in natural-image coordinates, or null for full frame. */
    crop: { x: number; y: number; w: number; h: number } | null;
}

const PEN_COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"];
const MAX_STD = 1280;
const MAX_HD = 2560;

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

export default function MediaEditor({ initialFiles, onSend, onClose }: MediaEditorProps) {
    const [items, setItems] = useState<EditItem[]>(() =>
        initialFiles.map((f, i) => ({
            id: `item_${Date.now()}_${i}`,
            img: null,
            url: URL.createObjectURL(f),
            strokes: [],
            rotation: 0,
            crop: null,
        })),
    );
    const [activeIdx, setActiveIdx] = useState(0);
    const [tool, setTool] = useState<Tool>("none");
    const [penColor, setPenColor] = useState(PEN_COLORS[0]);
    const [quality, setQuality] = useState<"standard" | "hd">("standard");
    const [viewOnce, setViewOnce] = useState(false);
    const [caption, setCaption] = useState("");
    const [busy, setBusy] = useState(false);

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const drawing = useRef(false);
    const cropDrag = useRef<{ startX: number; startY: number } | null>(null);
    const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

    const active = items[activeIdx];

    // Load bitmaps for any items that don't have one yet.
    useEffect(() => {
        let cancelled = false;
        items.forEach((it, idx) => {
            if (it.img) return;
            loadImage(it.url).then((img) => {
                if (cancelled) return;
                setItems((prev) => prev.map((p, i) => (i === idx ? { ...p, img } : p)));
            });
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items.length]);

    // Revoke object URLs on unmount.
    useEffect(() => {
        return () => {
            items.forEach((it) => URL.revokeObjectURL(it.url));
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Close on Escape.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    /** Returns the displayed (post-rotation, post-crop) dimensions of the image. */
    const getRenderSize = useCallback((it: EditItem) => {
        if (!it.img) return { w: 0, h: 0 };
        const rotated = it.rotation === 90 || it.rotation === 270;
        const natW = it.crop ? it.crop.w : it.img.naturalWidth;
        const natH = it.crop ? it.crop.h : it.img.naturalHeight;
        return rotated ? { w: natH, h: natW } : { w: natW, h: natH };
    }, []);

    /** Draw the active item onto the on-screen canvas. */
    const renderCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !active?.img) return;
        const { w, h } = getRenderSize(active);
        if (!w || !h) return;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, w, h);

        ctx.save();
        // Apply rotation around the canvas centre.
        ctx.translate(w / 2, h / 2);
        ctx.rotate((active.rotation * Math.PI) / 180);
        const rotated = active.rotation === 90 || active.rotation === 270;
        const dw = rotated ? h : w;
        const dh = rotated ? w : h;
        const sx = active.crop ? active.crop.x : 0;
        const sy = active.crop ? active.crop.y : 0;
        const sw = active.crop ? active.crop.w : active.img.naturalWidth;
        const sh = active.crop ? active.crop.h : active.img.naturalHeight;
        ctx.drawImage(active.img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();

        // Draw strokes (already stored in canvas display coords).
        active.strokes.forEach((stroke) => {
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = stroke.width;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            stroke.points.forEach((p, i) => {
                if (i === 0) ctx.moveTo(p.x, p.y);
                else ctx.lineTo(p.x, p.y);
            });
            ctx.stroke();
        });
    }, [active, getRenderSize]);

    useEffect(() => {
        renderCanvas();
    }, [renderCanvas]);

    /** Map a pointer event to canvas pixel coordinates. */
    const toCanvasCoords = (e: React.PointerEvent) => {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
        };
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        if (!active?.img) return;
        const pt = toCanvasCoords(e);
        if (tool === "pen") {
            drawing.current = true;
            const width = Math.max(3, canvasRef.current!.width / 180);
            setItems((prev) =>
                prev.map((p, i) =>
                    i === activeIdx
                        ? { ...p, strokes: [...p.strokes, { color: penColor, width, points: [pt] }] }
                        : p,
                ),
            );
        } else if (tool === "crop") {
            cropDrag.current = { startX: pt.x, startY: pt.y };
            setCropRect({ x: pt.x, y: pt.y, w: 0, h: 0 });
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (tool === "pen" && drawing.current) {
            const pt = toCanvasCoords(e);
            setItems((prev) =>
                prev.map((p, i) => {
                    if (i !== activeIdx) return p;
                    const strokes = [...p.strokes];
                    const last = strokes[strokes.length - 1];
                    if (last) last.points = [...last.points, pt];
                    return { ...p, strokes };
                }),
            );
        } else if (tool === "crop" && cropDrag.current) {
            const pt = toCanvasCoords(e);
            const { startX, startY } = cropDrag.current;
            setCropRect({
                x: Math.min(startX, pt.x),
                y: Math.min(startY, pt.y),
                w: Math.abs(pt.x - startX),
                h: Math.abs(pt.y - startY),
            });
        }
    };

    const handlePointerUp = () => {
        drawing.current = false;
        cropDrag.current = null;
    };

    /** Apply the dragged crop rect: bake the current canvas, then reset to a
        fresh image whose natural size equals the cropped region. */
    const applyCrop = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !cropRect || cropRect.w < 8 || cropRect.h < 8) {
            setTool("none");
            setCropRect(null);
            return;
        }
        // Snapshot the cropped pixels into a new image.
        const tmp = document.createElement("canvas");
        tmp.width = Math.round(cropRect.w);
        tmp.height = Math.round(cropRect.h);
        const tctx = tmp.getContext("2d");
        if (!tctx) return;
        tctx.drawImage(
            canvas,
            cropRect.x,
            cropRect.y,
            cropRect.w,
            cropRect.h,
            0,
            0,
            cropRect.w,
            cropRect.h,
        );
        const dataUrl = tmp.toDataURL("image/png");
        loadImage(dataUrl).then((img) => {
            setItems((prev) =>
                prev.map((p, i) =>
                    i === activeIdx
                        ? { ...p, img, strokes: [], rotation: 0, crop: null }
                        : p,
                ),
            );
        });
        setTool("none");
        setCropRect(null);
    }, [cropRect, activeIdx]);

    const rotate = () => {
        setItems((prev) =>
            prev.map((p, i) =>
                i === activeIdx ? { ...p, rotation: (p.rotation + 90) % 360 } : p,
            ),
        );
        // Strokes were drawn in the old orientation; clear them to avoid drift.
        setItems((prev) =>
            prev.map((p, i) => (i === activeIdx ? { ...p, strokes: [] } : p)),
        );
    };

    const undoStroke = () => {
        setItems((prev) =>
            prev.map((p, i) =>
                i === activeIdx ? { ...p, strokes: p.strokes.slice(0, -1) } : p,
            ),
        );
    };

    const addMore = (files: FileList | null) => {
        if (!files || files.length === 0) return;
        const next: EditItem[] = Array.from(files)
            .filter((f) => f.type.startsWith("image/"))
            .map((f, i) => ({
                id: `item_${Date.now()}_add_${i}`,
                img: null,
                url: URL.createObjectURL(f),
                strokes: [],
                rotation: 0,
                crop: null,
            }));
        if (next.length === 0) return;
        setItems((prev) => [...prev, ...next]);
    };

    const removeItem = (idx: number) => {
        setItems((prev) => {
            if (prev.length <= 1) {
                onClose();
                return prev;
            }
            URL.revokeObjectURL(prev[idx].url);
            const filtered = prev.filter((_, i) => i !== idx);
            return filtered;
        });
        setActiveIdx((cur) => Math.max(0, cur > idx ? cur - 1 : cur === idx ? Math.min(cur, items.length - 2) : cur));
    };

    /** Render a single item to a JPEG File at the chosen quality. */
    const exportItem = useCallback(
        async (it: EditItem): Promise<File> => {
            const img = it.img || (await loadImage(it.url));
            const rotated = it.rotation === 90 || it.rotation === 270;
            const baseW = it.crop ? it.crop.w : img.naturalWidth;
            const baseH = it.crop ? it.crop.h : img.naturalHeight;
            let outW = rotated ? baseH : baseW;
            let outH = rotated ? baseW : baseH;

            const maxDim = quality === "hd" ? MAX_HD : MAX_STD;
            const scale = Math.min(1, maxDim / Math.max(outW, outH));
            const finalW = Math.max(1, Math.round(outW * scale));
            const finalH = Math.max(1, Math.round(outH * scale));

            const out = document.createElement("canvas");
            out.width = finalW;
            out.height = finalH;
            const ctx = out.getContext("2d");
            if (!ctx) throw new Error("no ctx");

            // Draw rotated/cropped image scaled to the export size.
            ctx.save();
            ctx.translate(finalW / 2, finalH / 2);
            ctx.rotate((it.rotation * Math.PI) / 180);
            const dw = rotated ? finalH : finalW;
            const dh = rotated ? finalW : finalH;
            const sx = it.crop ? it.crop.x : 0;
            const sy = it.crop ? it.crop.y : 0;
            const sw = it.crop ? it.crop.w : img.naturalWidth;
            const sh = it.crop ? it.crop.h : img.naturalHeight;
            ctx.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();

            // Scale strokes from display canvas coords to export coords.
            const display = getRenderSize(it);
            const strokeScaleX = display.w ? finalW / display.w : 1;
            const strokeScaleY = display.h ? finalH / display.h : 1;
            it.strokes.forEach((stroke) => {
                ctx.strokeStyle = stroke.color;
                ctx.lineWidth = stroke.width * strokeScaleX;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                ctx.beginPath();
                stroke.points.forEach((p, i) => {
                    const x = p.x * strokeScaleX;
                    const y = p.y * strokeScaleY;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                });
                ctx.stroke();
            });

            const q = quality === "hd" ? 0.92 : 0.8;
            const blob: Blob = await new Promise((resolve, reject) =>
                out.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", q),
            );
            return new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
        },
        [quality, getRenderSize],
    );

    const handleSend = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const results: MediaEditorResult[] = [];
            for (const it of items) {
                const file = await exportItem(it);
                results.push({ file, viewOnce, caption });
            }
            onSend(results);
        } catch {
            setBusy(false);
        }
    };

    return (
        <div className={s.overlay}>
            <input
                type="file"
                accept="image/*"
                multiple
                ref={fileInputRef}
                style={{ display: "none" }}
                onChange={(e) => {
                    addMore(e.target.files);
                    e.target.value = "";
                }}
            />

            {/* Top bar */}
            <div className={s.topBar}>
                <button className={s.iconBtn} onClick={onClose} aria-label="Close">
                    <X size={22} />
                </button>
                <div className={s.topRight}>
                    <button
                        className={`${s.toolBtn} ${tool === "crop" ? s.toolActive : ""}`}
                        onClick={() => {
                            setTool(tool === "crop" ? "none" : "crop");
                            setCropRect(null);
                        }}
                        title="Crop"
                    >
                        <CropIcon size={20} />
                    </button>
                    <button className={s.toolBtn} onClick={rotate} title="Rotate">
                        <RotateCw size={20} />
                    </button>
                    <button
                        className={`${s.toolBtn} ${tool === "pen" ? s.toolActive : ""}`}
                        onClick={() => setTool(tool === "pen" ? "none" : "pen")}
                        title="Draw"
                    >
                        <Pencil size={20} />
                    </button>
                </div>
            </div>

            {/* Canvas stage */}
            <div className={s.stage}>
                <div className={s.canvasWrap}>
                    <canvas
                        ref={canvasRef}
                        className={s.canvas}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerLeave={handlePointerUp}
                        style={{ cursor: tool === "pen" ? "crosshair" : tool === "crop" ? "crosshair" : "default" }}
                    />
                    {tool === "crop" && cropRect && cropRect.w > 0 && (
                        <div
                            className={s.cropOverlay}
                            style={{
                                left: `${(cropRect.x / (canvasRef.current?.width || 1)) * 100}%`,
                                top: `${(cropRect.y / (canvasRef.current?.height || 1)) * 100}%`,
                                width: `${(cropRect.w / (canvasRef.current?.width || 1)) * 100}%`,
                                height: `${(cropRect.h / (canvasRef.current?.height || 1)) * 100}%`,
                            }}
                        />
                    )}
                </div>
            </div>

            {/* Pen palette */}
            {tool === "pen" && (
                <div className={s.penBar}>
                    {PEN_COLORS.map((c) => (
                        <button
                            key={c}
                            className={`${s.swatch} ${penColor === c ? s.swatchActive : ""}`}
                            style={{ background: c }}
                            onClick={() => setPenColor(c)}
                            aria-label={`Colour ${c}`}
                        />
                    ))}
                    <button className={s.penAction} onClick={undoStroke}>
                        Undo
                    </button>
                </div>
            )}

            {/* Crop confirm */}
            {tool === "crop" && (
                <div className={s.penBar}>
                    <button className={s.penAction} onClick={() => { setTool("none"); setCropRect(null); }}>
                        Cancel
                    </button>
                    <button className={`${s.penAction} ${s.penPrimary}`} onClick={applyCrop}>
                        <Check size={16} /> Apply crop
                    </button>
                </div>
            )}

            {/* Thumbnail tray (add more) */}
            <div className={s.tray}>
                {items.map((it, idx) => (
                    <div
                        key={it.id}
                        className={`${s.thumb} ${idx === activeIdx ? s.thumbActive : ""}`}
                        onClick={() => setActiveIdx(idx)}
                    >
                        <img src={it.url} alt="" />
                        {items.length > 1 && (
                            <button
                                className={s.thumbRemove}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    removeItem(idx);
                                }}
                                aria-label="Remove"
                            >
                                <Trash2 size={12} />
                            </button>
                        )}
                    </div>
                ))}
                <button className={s.addMore} onClick={() => fileInputRef.current?.click()} aria-label="Add more">
                    <Plus size={20} />
                </button>
            </div>

            {/* Options row: quality + view-once */}
            <div className={s.optionsRow}>
                <button
                    className={`${s.optionPill} ${quality === "standard" ? s.optionActive : ""}`}
                    onClick={() => setQuality("standard")}
                >
                    Standard
                </button>
                <button
                    className={`${s.optionPill} ${quality === "hd" ? s.optionActive : ""}`}
                    onClick={() => setQuality("hd")}
                >
                    HD
                </button>
                <button
                    className={`${s.optionPill} ${viewOnce ? s.optionActive : ""}`}
                    onClick={() => setViewOnce((v) => !v)}
                    title={viewOnce ? "View once" : "View infinity"}
                >
                    <Timer size={15} />
                    {viewOnce ? "View once" : "View ∞"}
                </button>
            </div>

            {/* Caption + send */}
            <div className={s.bottomBar}>
                <input
                    className={s.caption}
                    placeholder="Add a caption..."
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                />
                <button className={s.sendBtn} onClick={handleSend} disabled={busy} aria-label="Send">
                    <Send size={20} />
                </button>
            </div>
        </div>
    );
}
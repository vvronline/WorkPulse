import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, Image as ImageIcon, Wand2, Ban, Upload, Check } from 'lucide-react';
import {
    BUILTIN_BACKGROUNDS,
    isBackgroundEffectsSupported,
} from '../../utils/backgroundEffects';
// Import the shared style sheet so the picker brings its own .bg-fx-* CSS
// regardless of which screen renders it (in-call bottom bar, pre-call lobby,
// future settings page, etc.). Vite de-dupes the import so this is free.
import './MeetingRoom.css';

/**
 * BackgroundEffectsPicker — popover panel that lets the user pick a
 * background effect (none, blur, built-in image, or uploaded image).
 *
 * Stateless w.r.t. the meeting: it just calls `onChange(effect)` with the
 * standard `{ type, ... }` shape and lets the host (MeetingRoom or
 * MeetingJoin) decide what to do with it.
 *
 * Why a single component for both places?
 *  - Same UX in pre-call lobby and in-call control bar
 *  - Single source of truth for which effects exist
 *  - Cheap to render — no model is loaded here, that happens in the
 *    BackgroundProcessor itself once the effect is actually applied.
 */
export default function BackgroundEffectsPicker({
    value = { type: 'none' },
    onChange,
    onClose,
    anchor = 'bottom', // 'bottom' renders above the trigger; 'top' renders below
    title = 'Background Effects',
    // Optional: error string surfaced from the host (the meeting hook /
    // lobby) when the last effect application failed (e.g. CSP blocked
    // the WASM module). When set, the picker shows a banner so the user
    // understands why the preview doesn't reflect their selection.
    error = null,
}) {
    const [supported] = useState(() => isBackgroundEffectsSupported());
    const [blurStrength, setBlurStrength] = useState(
        value?.type === 'blur' ? Number(value.strength) || 12 : 12,
    );
    const [uploadedSrc, setUploadedSrc] = useState(
        value?.type === 'image' && !BUILTIN_BACKGROUNDS.some(b => b.src === value.src) ? value.src : null,
    );
    const fileRef = useRef(null);
    const panelRef = useRef(null);

    // Click outside / Escape to close.
    useEffect(() => {
        if (!onClose) return;
        const onDocClick = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target)) onClose();
        };
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        // Defer so the click that opened us doesn't immediately close it.
        const t = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
        document.addEventListener('keydown', onKey);
        return () => {
            clearTimeout(t);
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    const apply = (effect) => { onChange?.(effect); };

    const handleBlur = () => apply({ type: 'blur', strength: blurStrength });
    const handleNone = () => apply({ type: 'none' });
    const handleBuiltin = (b) => apply({ type: 'image', src: b.src });

    const handleFile = (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        if (!f.type.startsWith('image/')) return;
        // Cap at ~6 MB to keep the canvas pipeline snappy.
        if (f.size > 6 * 1024 * 1024) {
            alert('Please choose an image smaller than 6 MB.');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const src = String(reader.result || '');
            setUploadedSrc(src);
            apply({ type: 'image', src });
        };
        reader.readAsDataURL(f);
    };

    const isCurrent = (predicate) => {
        try { return predicate(value); } catch { return false; }
    };

    return (
        <div
            ref={panelRef}
            className={`bg-fx-panel bg-fx-panel-${anchor}`}
            role="dialog"
            aria-label={title}
        >
            <div className="bg-fx-header">
                <Sparkles size={14} />
                <span>{title}</span>
            </div>

            {!supported ? (
                <div className="bg-fx-warning">
                    Your browser doesn't support background effects.
                    <br />Try the latest Chrome, Edge, or Firefox.
                </div>
            ) : (
                <>
                    {error && (
                        <div className="bg-fx-warning" style={{ marginBottom: '0.6rem' }}>
                            {error}
                        </div>
                    )}
                    <div className="bg-fx-row">
                        <button
                            type="button"
                            className={`bg-fx-tile bg-fx-tile-plain ${isCurrent(v => v?.type === 'none') ? 'bg-fx-tile-active' : ''}`}
                            onClick={handleNone}
                            title="No effect"
                        >
                            <Ban size={18} />
                            <span>None</span>
                            {isCurrent(v => v?.type === 'none') && <Check size={12} className="bg-fx-check" />}
                        </button>

                        <button
                            type="button"
                            className={`bg-fx-tile bg-fx-tile-plain ${isCurrent(v => v?.type === 'blur') ? 'bg-fx-tile-active' : ''}`}
                            onClick={handleBlur}
                            title="Blur background"
                        >
                            <Wand2 size={18} />
                            <span>Blur</span>
                            {isCurrent(v => v?.type === 'blur') && <Check size={12} className="bg-fx-check" />}
                        </button>
                    </div>

                    {value?.type === 'blur' && (
                        <div className="bg-fx-blur-row">
                            <label htmlFor="bgfx-blur">Blur strength</label>
                            <input
                                id="bgfx-blur"
                                type="range"
                                min={4}
                                max={30}
                                step={1}
                                value={blurStrength}
                                onChange={(e) => {
                                    const n = Number(e.target.value);
                                    setBlurStrength(n);
                                    apply({ type: 'blur', strength: n });
                                }}
                            />
                            <span className="bg-fx-blur-val">{blurStrength}</span>
                        </div>
                    )}

                    <div className="bg-fx-section-label">
                        <ImageIcon size={12} /> Virtual backgrounds
                    </div>
                    <div className="bg-fx-grid">
                        {BUILTIN_BACKGROUNDS.map(b => {
                            const active = isCurrent(v => v?.type === 'image' && v?.src === b.src);
                            return (
                                <button
                                    key={b.key}
                                    type="button"
                                    className={`bg-fx-thumb ${active ? 'bg-fx-thumb-active' : ''}`}
                                    onClick={() => handleBuiltin(b)}
                                    title={b.label}
                                    style={{ backgroundImage: `url("${b.src}")` }}
                                >
                                    <span className="bg-fx-thumb-label">{b.label}</span>
                                    {active && <Check size={14} className="bg-fx-thumb-check" />}
                                </button>
                            );
                        })}
                        {uploadedSrc && (
                            <button
                                type="button"
                                className={`bg-fx-thumb ${isCurrent(v => v?.type === 'image' && v?.src === uploadedSrc) ? 'bg-fx-thumb-active' : ''}`}
                                onClick={() => apply({ type: 'image', src: uploadedSrc })}
                                title="Custom upload"
                                style={{ backgroundImage: `url("${uploadedSrc}")` }}
                            >
                                <span className="bg-fx-thumb-label">Custom</span>
                                {isCurrent(v => v?.type === 'image' && v?.src === uploadedSrc) && <Check size={14} className="bg-fx-thumb-check" />}
                            </button>
                        )}
                    </div>

                    <button
                        type="button"
                        className="bg-fx-upload"
                        onClick={() => fileRef.current?.click()}
                    >
                        <Upload size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                        Upload image
                    </button>
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={handleFile}
                    />
                    <p className="bg-fx-hint">
                        Effects run locally in your browser. Custom uploads are not stored or sent anywhere.
                    </p>
                </>
            )}
        </div>
    );
}
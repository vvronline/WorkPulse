/**
 * StatusPicker — the v2 user-status menu in the navbar/profile dropdown.
 *
 * INVARIANTS:
 *   • Reads the resolved effective state from `useStatus()` — no local
 *     computation, no API calls of its own.
 *   • Only fires mutators: `setManualStatus` (manual choice) and
 *     `setInvisible` (Appear Offline toggle).
 *   • Picker rows come from `PICKABLE_STATUSES` (the four manual values).
 *     `STATUS_META` drives all visual treatment so changing a colour or
 *     icon is a one-place edit.
 *   • Server-derived statuses (away / in_call / in_meeting / offline)
 *     can be DISPLAYED at the top but are not selectable.
 */

import { useState, useRef } from 'react';
import { Check, Minus, Clock3, Phone, Video } from 'lucide-react';
import { useStatus } from '../../status/useStatus';
import { PICKABLE_STATUSES, STATUS_META } from '../../status/constants';
import { useClickOutside } from '../../hooks/useClickOutside';
import s from './StatusPicker.module.css';

/** Render the small glyph shown inside the colored dot. */
function StatusGlyph({ icon }) {
    if (icon === 'check') return <Check size={9} strokeWidth={3} />;
    if (icon === 'minus') return <Minus size={9} strokeWidth={3} />;
    if (icon === 'clock') return <Clock3 size={8} strokeWidth={2.6} />;
    if (icon === 'phone') return <Phone size={8} strokeWidth={2.6} />;
    if (icon === 'video') return <Video size={8} strokeWidth={2.6} />;
    if (icon === 'ring') return <span className={s.ringGlyph} />;
    return <span className={s.dotGlyph} />;
}

export default function StatusPicker() {
    const {
        effective,
        presencePreference,
        setManualStatus,
        setInvisible,
    } = useStatus();

    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useClickOutside(ref, () => setOpen(false));

    const currentMeta = STATUS_META[effective] || STATUS_META.available;
    const isInvisible = presencePreference === 'invisible';
    // A status is "auto" when it was derived by the server resolver from
    // activity (in_call/in_meeting) or idleness (away). The user can't
    // pick these directly — they're displayed read-only with an "auto" badge.
    const isAutoStatus = !!currentMeta?.auto;

    const handlePick = async (key) => {
        setOpen(false);
        // Clearing invisible if the user picks a positive status feels
        // natural: "Available" should make them visible again.
        if (isInvisible) await setInvisible(false);
        await setManualStatus(key);
    };

    const handleInvisibleToggle = async () => {
        setOpen(false);
        await setInvisible(!isInvisible);
    };

    return (
        <div className={s.picker} ref={ref}>
            <button
                className={s.trigger}
                onClick={() => setOpen(o => !o)}
                aria-label={`Status: ${currentMeta.label}`}
            >
                <span
                    className={`${s.statusDot} ${currentMeta.kind === 'ring' ? s.ring : ''}`}
                    style={{
                        background: currentMeta.kind === 'ring' ? 'transparent' : currentMeta.color,
                        color: '#fff',
                    }}
                >
                    <StatusGlyph icon={currentMeta.icon} />
                </span>
                <span className={s.statusLabel}>{currentMeta.label}</span>
                {isAutoStatus && <span className={s.autoBadge}>auto</span>}
                <svg className={s.chevron} width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>

            {open && (
                <div className={s.dropdown}>
                    <div className={s.dropdownTitle}>Set status</div>
                    {PICKABLE_STATUSES.map(st => (
                        <button
                            key={st.key}
                            className={`${s.option} ${effective === st.key && !isInvisible ? s.active : ''}`}
                            onClick={() => handlePick(st.key)}
                        >
                            <span
                                className={`${s.optionDot} ${st.kind === 'ring' ? s.ring : ''}`}
                                style={{
                                    background: st.kind === 'ring' ? 'transparent' : st.color,
                                    color: '#fff',
                                }}
                            >
                                <StatusGlyph icon={st.icon} />
                            </span>
                            <span className={s.optionLabel}>{st.label}</span>
                        </button>
                    ))}

                    {/* Appear Offline — separate toggle (it's a presence
                        preference, not a manual status). The legacy v1
                        client conflated the two; v2 keeps them distinct
                        so toggling Available doesn't silently drop a
                        custom "Busy" choice and vice versa. */}
                    <button
                        className={`${s.option} ${isInvisible ? s.active : ''}`}
                        onClick={handleInvisibleToggle}
                    >
                        <span className={`${s.optionDot} ${s.ring}`}>
                            <span className={s.ringGlyph} />
                        </span>
                        <span className={s.optionLabel}>
                            {isInvisible ? 'Stop appearing offline' : 'Appear Offline'}
                        </span>
                    </button>

                    {isAutoStatus && (
                        <div className={s.autoNote}>
                            Status automatically set to "{currentMeta.label}" — will revert when done.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
import { useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Volume2, VolumeX, Play, Bell, MessageCircle, AtSign, Smile, PhoneOutgoing, PhoneCall, RotateCcw } from 'lucide-react';
import { useNotificationPrefs } from '../../NotificationPrefsContext';
import {
    RINGTONES, OUTGOING_TONES, MESSAGE_TONES, MENTION_TONES, REACTION_TONES,
} from '../../utils/sounds';
import s from './NotificationSoundsModal.module.css';

/**
 * Reusable section row: dropdown + preview button + volume slider.
 */
function ToneRow({ icon, label, presets, value, onChange, volume, onVolumeChange, onPreview, disabled }) {
    return (
        <div className={`${s.row} ${disabled ? s.rowDisabled : ''}`}>
            <div className={s.rowHeader}>
                <span className={s.rowIcon}>{icon}</span>
                <span className={s.rowLabel}>{label}</span>
            </div>
            <div className={s.rowControls}>
                <select
                    className={s.select}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    disabled={disabled}
                >
                    {presets.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
                <button
                    type="button"
                    className={s.previewBtn}
                    onClick={onPreview}
                    disabled={disabled || value === 'none'}
                    title="Preview"
                    aria-label={`Preview ${label}`}
                >
                    <Play size={14} />
                </button>
                {onVolumeChange && (
                    <div className={s.volumeWrap} title={`Volume: ${Math.round((volume ?? 0) * 100)}%`}>
                        <Volume2 size={14} className={s.volIcon} />
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={volume ?? 0.5}
                            onChange={e => onVolumeChange(parseFloat(e.target.value))}
                            disabled={disabled}
                            className={s.slider}
                            aria-label={`${label} volume`}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

export default function NotificationSoundsModal({ onClose }) {
    const { prefs, updatePrefs, resetPrefs, preview } = useNotificationPrefs();
    const overlayRef = useRef(null);

    // Close on Escape, click-outside.
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const onOverlayClick = (e) => { if (e.target === overlayRef.current) onClose(); };

    const muted = !!prefs.muteAll;

    const handleReset = useCallback(() => {
        resetPrefs();
    }, [resetPrefs]);

    return createPortal((
        <div ref={overlayRef} className={s.overlay} onMouseDown={onOverlayClick}>
            <div className={s.modal} role="dialog" aria-modal="true" aria-labelledby="ns-title">
                <div className={s.header}>
                    <div className={s.titleWrap}>
                        <Bell size={18} className={s.titleIcon} />
                        <h2 id="ns-title" className={s.title}>Notification sounds</h2>
                    </div>
                    <button className={s.closeBtn} onClick={onClose} aria-label="Close">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                    </button>
                </div>

                <div className={s.body}>
                    {/* Master mute toggle */}
                    <div className={s.muteCard}>
                        <div className={s.muteCardLeft}>
                            <span className={s.muteIcon}>
                                {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                            </span>
                            <div>
                                <div className={s.muteTitle}>Mute all sounds</div>
                                <div className={s.muteHint}>
                                    Disables every ringtone, message and mention sound until turned off.
                                </div>
                            </div>
                        </div>
                        <label className={s.switch} aria-label="Mute all sounds">
                            <input
                                type="checkbox"
                                checked={muted}
                                onChange={e => updatePrefs({ muteAll: e.target.checked })}
                            />
                            <span className={s.switchKnob} />
                        </label>
                    </div>

                    {/* Calls */}
                    <div className={s.section}>
                        <div className={s.sectionTitle}>Calls</div>
                        <ToneRow
                            icon={<PhoneCall size={16} />}
                            label="Incoming call ringtone"
                            presets={RINGTONES}
                            value={prefs.ringtone}
                            onChange={(id) => { updatePrefs({ ringtone: id }); preview('ringtone', id, prefs.ringtoneVolume); }}
                            volume={prefs.ringtoneVolume}
                            onVolumeChange={(v) => updatePrefs({ ringtoneVolume: v })}
                            onPreview={() => preview('ringtone', prefs.ringtone, prefs.ringtoneVolume)}
                            disabled={muted}
                        />
                        <ToneRow
                            icon={<PhoneOutgoing size={16} />}
                            label="Outgoing call tone"
                            presets={OUTGOING_TONES}
                            value={prefs.outgoingTone}
                            onChange={(id) => { updatePrefs({ outgoingTone: id }); preview('outgoing', id, prefs.outgoingVolume); }}
                            volume={prefs.outgoingVolume}
                            onVolumeChange={(v) => updatePrefs({ outgoingVolume: v })}
                            onPreview={() => preview('outgoing', prefs.outgoingTone, prefs.outgoingVolume)}
                            disabled={muted}
                        />
                    </div>

                    {/* Messages */}
                    <div className={s.section}>
                        <div className={s.sectionTitle}>Messages</div>
                        <ToneRow
                            icon={<MessageCircle size={16} />}
                            label="New message"
                            presets={MESSAGE_TONES}
                            value={prefs.messageTone}
                            onChange={(id) => { updatePrefs({ messageTone: id }); preview('message', id, prefs.messageVolume); }}
                            volume={prefs.messageVolume}
                            onVolumeChange={(v) => updatePrefs({ messageVolume: v })}
                            onPreview={() => preview('message', prefs.messageTone, prefs.messageVolume)}
                            disabled={muted}
                        />
                        <ToneRow
                            icon={<AtSign size={16} />}
                            label="Mention / @-tag"
                            presets={MENTION_TONES}
                            value={prefs.mentionTone}
                            onChange={(id) => { updatePrefs({ mentionTone: id }); preview('mention', id, prefs.mentionVolume); }}
                            volume={prefs.mentionVolume}
                            onVolumeChange={(v) => updatePrefs({ mentionVolume: v })}
                            onPreview={() => preview('mention', prefs.mentionTone, prefs.mentionVolume)}
                            disabled={muted}
                        />
                        <ToneRow
                            icon={<Smile size={16} />}
                            label="Reaction"
                            presets={REACTION_TONES}
                            value={prefs.reactionTone}
                            onChange={(id) => { updatePrefs({ reactionTone: id }); preview('reaction', id, prefs.reactionVolume); }}
                            volume={prefs.reactionVolume}
                            onVolumeChange={(v) => updatePrefs({ reactionVolume: v })}
                            onPreview={() => preview('reaction', prefs.reactionTone, prefs.reactionVolume)}
                            disabled={muted}
                        />
                    </div>

                    {/* Behavior */}
                    <div className={s.section}>
                        <div className={s.sectionTitle}>Behavior</div>

                        <label className={s.checkboxRow}>
                            <input
                                type="checkbox"
                                checked={!!prefs.playWhenFocused}
                                onChange={e => updatePrefs({ playWhenFocused: e.target.checked })}
                            />
                            <span>
                                <span className={s.checkboxTitle}>Play sounds even when app is focused</span>
                                <span className={s.checkboxHint}>By default, sounds only play when the window is in the background.</span>
                            </span>
                        </label>

                        <label className={s.checkboxRow}>
                            <input
                                type="checkbox"
                                checked={!!prefs.playOnSend}
                                onChange={e => updatePrefs({ playOnSend: e.target.checked })}
                            />
                            <span>
                                <span className={s.checkboxTitle}>Play a sound when I send a message</span>
                                <span className={s.checkboxHint}>A subtle confirmation tone after each message is sent.</span>
                            </span>
                        </label>
                    </div>
                </div>

                <div className={s.footer}>
                    <button className={s.resetBtn} onClick={handleReset} type="button" title="Reset to defaults">
                        <RotateCcw size={14} /> Reset to defaults
                    </button>
                    <button className={s.doneBtn} onClick={onClose} type="button">
                        Done
                    </button>
                </div>
            </div>
        </div>
    ), document.body);
}

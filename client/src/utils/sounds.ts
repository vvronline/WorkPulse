/**
 * Synthesised notification & ringtone presets via the Web Audio API.
 *
 * Every preset is purely synthesised (no binary assets), so they ship with
 * zero footprint and work offline. Each preset exposes a `synth(ctx, volume)`
 * function that schedules its sound on the shared AudioContext and returns
 * the approximate duration (ms) so loops know when to re-fire.
 *
 * `playSound(category, id, { volume, loop })` is the single entry point and
 * always returns a `stop()` function — no-op for one-shots, for looped
 * sounds (ringtones) it cancels the next iteration.
 */

type SynthFn = (ctx: AudioContext, volume: number) => number;

export interface SoundPreset {
    id: string;
    name: string;
    synth: SynthFn | null;
}

export type SoundCategory = "ringtone" | "outgoing" | "message" | "mention" | "reaction";

let audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!audioCtx || audioCtx.state === "closed") {
        const Ctor = window.AudioContext
            || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        audioCtx = new Ctor();
    }
    if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => { /* autoplay restriction */ });
    }
    return audioCtx;
}

/* ─── Tiny helpers ──────────────────────────────────────────────────── */

function tone(
    ctx: AudioContext,
    freq: number,
    startOffset: number,
    duration: number,
    volume: number,
    type: OscillatorType = "sine",
): void {
    const t0 = ctx.currentTime + startOffset;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.connect(gain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
}

function pluck(
    ctx: AudioContext,
    freq: number,
    startOffset: number,
    duration: number,
    volume: number,
): void {
    // Pluck = sine + quick decay = bell/marimba-ish
    const t0 = ctx.currentTime + startOffset;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t0);
    osc.connect(gain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);

    // overtone for bell character
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(freq * 2, t0);
    const g2 = ctx.createGain();
    g2.connect(ctx.destination);
    g2.gain.setValueAtTime(volume * 0.4, t0);
    g2.gain.exponentialRampToValueAtTime(0.0001, t0 + duration * 0.6);
    osc2.connect(g2);
    osc2.start(t0);
    osc2.stop(t0 + duration + 0.05);
}

/* ─── RINGTONE patterns (looping, ~1.5–2.5s each) ───────────────────── */

function classicRing(ctx: AudioContext, vol: number): number {
    // Two short pulses 440 Hz then silence — telephone classic
    tone(ctx, 440, 0, 0.4, vol * 0.6, "sine");
    tone(ctx, 440, 0.5, 0.4, vol * 0.6, "sine");
    return 2000;
}

function calmRing(ctx: AudioContext, vol: number): number {
    // Soft low rising chord
    pluck(ctx, 392, 0, 1.2, vol * 0.5);   // G4
    pluck(ctx, 523, 0.15, 1.2, vol * 0.4); // C5
    pluck(ctx, 659, 0.3, 1.4, vol * 0.4);  // E5
    return 2400;
}

function dynamicRing(ctx: AudioContext, vol: number): number {
    // Bouncing arpeggio
    const notes = [523, 659, 784, 659]; // C5 E5 G5 E5
    notes.forEach((f, i) => tone(ctx, f, i * 0.18, 0.16, vol * 0.55, "square"));
    return 1800;
}

function urgentRing(ctx: AudioContext, vol: number): number {
    // Fast triple beep, alarm-like
    for (let i = 0; i < 3; i++) {
        tone(ctx, 880, i * 0.18, 0.13, vol * 0.7, "sawtooth");
    }
    return 1600;
}

function boopRing(ctx: AudioContext, vol: number): number {
    // Two playful low boops
    tone(ctx, 330, 0, 0.25, vol * 0.65, "sine");
    tone(ctx, 247, 0.32, 0.3, vol * 0.65, "sine");
    return 2000;
}

function marimbaRing(ctx: AudioContext, vol: number): number {
    // Marimba arpeggio C E G C
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => pluck(ctx, f, i * 0.18, 0.45, vol * 0.5));
    return 2200;
}

function crystalRing(ctx: AudioContext, vol: number): number {
    // Clean glassy triad shimmer
    pluck(ctx, 659, 0, 0.9, vol * 0.48);
    pluck(ctx, 988, 0.1, 0.9, vol * 0.4);
    pluck(ctx, 1318, 0.2, 1, vol * 0.34);
    return 2200;
}

function vaporRing(ctx: AudioContext, vol: number): number {
    // Modern soft synth pulse
    const notes = [392, 523, 659, 784];
    notes.forEach((f, i) => tone(ctx, f, i * 0.22, 0.2, vol * 0.5, "triangle"));
    return 2000;
}

/* ─── OUTGOING (ring-back you hear while dialing) ───────────────────── */

function ringbackTone(ctx: AudioContext, vol: number): number {
    // Standard 440+480 Hz ring-back, 1s on / 1s off
    tone(ctx, 440, 0, 0.9, vol * 0.35, "sine");
    tone(ctx, 480, 0, 0.9, vol * 0.35, "sine");
    return 2000;
}

function pulseOutgoing(ctx: AudioContext, vol: number): number {
    // Slow single soft pulse
    tone(ctx, 523, 0, 0.45, vol * 0.45, "sine");
    return 1500;
}

function softOutgoing(ctx: AudioContext, vol: number): number {
    // Gentle two-note "calling…" feel
    pluck(ctx, 659, 0, 0.7, vol * 0.4);
    pluck(ctx, 523, 0.4, 0.7, vol * 0.4);
    return 2000;
}

function echoOutgoing(ctx: AudioContext, vol: number): number {
    tone(ctx, 587, 0, 0.2, vol * 0.45, "triangle");
    tone(ctx, 587, 0.24, 0.18, vol * 0.3, "triangle");
    return 1500;
}

function driftOutgoing(ctx: AudioContext, vol: number): number {
    pluck(ctx, 740, 0, 0.5, vol * 0.4);
    tone(ctx, 622, 0.3, 0.35, vol * 0.28, "sine");
    return 1700;
}

/* ─── MESSAGE tones (one-shot) ──────────────────────────────────────── */

function dingTone(ctx: AudioContext, vol: number): number {
    // Two-note rising ding (the previous default)
    tone(ctx, 880, 0, 0.12, vol, "sine");
    tone(ctx, 1175, 0.12, 0.22, vol, "sine");
    return 400;
}

function popTone(ctx: AudioContext, vol: number): number {
    // Quick low pop
    const t0 = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(180, t0);
    osc.frequency.exponentialRampToValueAtTime(80, t0 + 0.12);
    osc.connect(gain);
    osc.start(t0);
    osc.stop(t0 + 0.15);
    return 200;
}

function chimeTone(ctx: AudioContext, vol: number): number {
    // Three ascending bell tones
    pluck(ctx, 784, 0, 0.4, vol * 0.55);
    pluck(ctx, 988, 0.08, 0.4, vol * 0.55);
    pluck(ctx, 1175, 0.16, 0.5, vol * 0.55);
    return 700;
}

function knockTone(ctx: AudioContext, vol: number): number {
    // Two quick wood-block knocks
    for (let i = 0; i < 2; i++) {
        const t0 = ctx.currentTime + i * 0.12;
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(vol * 0.8, t0);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
        const osc = ctx.createOscillator();
        osc.type = "square";
        osc.frequency.setValueAtTime(220, t0);
        osc.connect(gain);
        osc.start(t0);
        osc.stop(t0 + 0.08);
    }
    return 350;
}

function subtleTone(ctx: AudioContext, vol: number): number {
    // Single soft high blip
    tone(ctx, 1046, 0, 0.15, vol * 0.55, "sine");
    return 200;
}

function glassyTone(ctx: AudioContext, vol: number): number {
    pluck(ctx, 1046, 0, 0.25, vol * 0.55);
    pluck(ctx, 1318, 0.06, 0.22, vol * 0.42);
    return 320;
}

function rippleTone(ctx: AudioContext, vol: number): number {
    tone(ctx, 660, 0, 0.1, vol * 0.65, "triangle");
    tone(ctx, 880, 0.08, 0.14, vol * 0.5, "triangle");
    tone(ctx, 1175, 0.18, 0.12, vol * 0.4, "triangle");
    return 380;
}

/* ─── MENTION tones ─────────────────────────────────────────────────── */

function mentionTone(ctx: AudioContext, vol: number): number {
    // Three rising notes
    const notes = [784, 988, 1175];
    notes.forEach((f, i) => tone(ctx, f, i * 0.1, 0.15, vol, "sine"));
    return 500;
}

function urgentMention(ctx: AudioContext, vol: number): number {
    // Quick double alert
    tone(ctx, 1175, 0, 0.12, vol, "sawtooth");
    tone(ctx, 1480, 0.16, 0.16, vol, "sawtooth");
    return 400;
}

function sparkMention(ctx: AudioContext, vol: number): number {
    pluck(ctx, 1175, 0, 0.2, vol * 0.65);
    pluck(ctx, 1568, 0.08, 0.18, vol * 0.45);
    return 320;
}

function clickReaction(ctx: AudioContext, vol: number): number {
    tone(ctx, 1200, 0, 0.05, vol * 0.6, "square");
    return 120;
}

/* ─── Registry ──────────────────────────────────────────────────────── */

export const RINGTONES: SoundPreset[] = [
    { id: "classic", name: "Classic", synth: classicRing },
    { id: "calm", name: "Calm", synth: calmRing },
    { id: "dynamic", name: "Dynamic", synth: dynamicRing },
    { id: "urgent", name: "Urgent", synth: urgentRing },
    { id: "boop", name: "Boop", synth: boopRing },
    { id: "marimba", name: "Marimba", synth: marimbaRing },
    { id: "crystal", name: "Crystal", synth: crystalRing },
    { id: "vapor", name: "Vapor", synth: vaporRing },
    { id: "none", name: "None (silent)", synth: null },
];

export const OUTGOING_TONES: SoundPreset[] = [
    { id: "ringback", name: "Ringback (classic)", synth: ringbackTone },
    { id: "pulse", name: "Pulse", synth: pulseOutgoing },
    { id: "soft", name: "Soft", synth: softOutgoing },
    { id: "echo", name: "Echo", synth: echoOutgoing },
    { id: "drift", name: "Drift", synth: driftOutgoing },
    { id: "none", name: "None (silent)", synth: null },
];

export const MESSAGE_TONES: SoundPreset[] = [
    { id: "ding", name: "Ding", synth: dingTone },
    { id: "pop", name: "Pop", synth: popTone },
    { id: "chime", name: "Chime", synth: chimeTone },
    { id: "knock", name: "Knock", synth: knockTone },
    { id: "subtle", name: "Subtle", synth: subtleTone },
    { id: "glassy", name: "Glassy", synth: glassyTone },
    { id: "ripple", name: "Ripple", synth: rippleTone },
    { id: "none", name: "None (silent)", synth: null },
];

export const MENTION_TONES: SoundPreset[] = [
    { id: "mention", name: "Mention", synth: mentionTone },
    { id: "chime", name: "Chime", synth: chimeTone },
    { id: "urgent", name: "Urgent", synth: urgentMention },
    { id: "spark", name: "Spark", synth: sparkMention },
    { id: "none", name: "None (silent)", synth: null },
];

export const REACTION_TONES: SoundPreset[] = [
    { id: "subtle", name: "Subtle", synth: subtleTone },
    { id: "pop", name: "Pop", synth: popTone },
    { id: "click", name: "Click", synth: clickReaction },
    { id: "none", name: "None (silent)", synth: null },
];

const REGISTRY: Record<SoundCategory, SoundPreset[]> = {
    ringtone: RINGTONES,
    outgoing: OUTGOING_TONES,
    message: MESSAGE_TONES,
    mention: MENTION_TONES,
    reaction: REACTION_TONES,
};

/**
 * Default IDs per category. Used if user has not set a preference yet.
 */
export const DEFAULT_PREFS = {
    v: 1,
    muteAll: false,
    ringtone: "classic",
    ringtoneVolume: 0.6,
    outgoingTone: "ringback",
    outgoingVolume: 0.4,
    messageTone: "ding",
    messageVolume: 0.5,
    mentionTone: "mention",
    mentionVolume: 0.6,
    reactionTone: "subtle",
    reactionVolume: 0.4,
    playWhenFocused: false,
    playOnSend: false,
    // Privacy (Signal parity): reciprocal read receipts. When false, the
    // server neither shares your read state nor shows you others'.
    readReceipts: true,
};

/**
 * Look up a preset's display label by category + id. Returns `id` if unknown.
 */
export function getPresetLabel(category: SoundCategory, id: string): string {
    return REGISTRY[category]?.find(p => p.id === id)?.name || id;
}

/**
 * Play a sound. For one-shots returns a no-op stop function. For looping
 * sounds (ringtones) returns a real `stop()` that cancels the next loop.
 */
export function playSound(
    category: SoundCategory,
    id: string,
    { volume = 0.5, loop = false }: { volume?: number; loop?: boolean } = {},
): () => void {
    const presets = REGISTRY[category];
    if (!presets) return () => { };
    const preset = presets.find(p => p.id === id) || presets[0];
    if (!preset || !preset.synth || id === "none") return () => { };
    const ctx = getAudioCtx();
    if (!ctx) return () => { };

    try {
        const duration = preset.synth(ctx, volume) || 800;
        if (!loop) return () => { };

        let cancelled = false;
        const tick = () => {
            if (cancelled) return;
            try {
                const d = (preset.synth ? preset.synth(ctx, volume) : 0) || 800;
                setTimeout(tick, d + 100);
            } catch { /* ctx may have closed */ }
        };
        const t = setTimeout(tick, duration + 100);
        return () => {
            cancelled = true;
            clearTimeout(t);
        };
    } catch {
        return () => { };
    }
}

/** Convenience preview helper for the settings UI — plays a single iteration. */
export function previewSound(category: SoundCategory, id: string, volume = 0.5): () => void {
    return playSound(category, id, { volume, loop: false });
}
/**
 * Generates the bundled Android call-notification ringtone audio files — ONE
 * per selectable ringtone option, so the killed/background status-bar call can
 * ring with the user's SELECTED ringtone (not just a single fixed tone).
 *
 * WHY THIS EXISTS:
 * The in-app call SCREEN plays the user's selected ringtone as a synthesized
 * WAV data-URI (see src/utils/notificationSoundPreview.ts). But an Android
 * notification CHANNEL — and the killed/background full-screen-intent call
 * notification posted BEFORE the screen mounts — can ONLY ring with a real
 * bundled `res/raw` audio resource; it CANNOT use a JS data-URI, and a channel's
 * sound is IMMUTABLE after creation. So to honour the SELECTED ringtone in the
 * status-bar state we bundle a real WAV for EVERY ringtone option and create one
 * channel per option (see notifeeService); displayIncomingCall then posts on the
 * channel matching the user's choice.
 *
 * The note frequencies below MIRROR the in-app preview vocabulary
 * (notificationSoundPreview.PREVIEW_NOTES) so the status-bar ring sounds the
 * SAME as the in-call ring for each option. Each file is rendered as a short
 * melodic phrase + a trailing silence so the channel's loop has a natural
 * "ring … pause … ring" cadence like a real phone.
 *
 * Output: mobile/assets/sounds/ringtone_<id>.wav (+ ringback.wav for the
 * outgoing tone). The `withAndroidRingtoneAssets` config plugin copies these
 * into android/app/src/main/res/raw at prebuild (resource name = file name
 * without extension; must be [a-z0-9_]).
 *
 * Run: `node scripts/generate-call-sounds.cjs` (also wired as an npm script).
 */

const fs = require("fs");
const path = require("path");

const SAMPLE_RATE = 44100;

// Ringtone tone-id → note frequencies (Hz), mirroring the in-app preview
// (src/utils/notificationSoundPreview.ts PREVIEW_NOTES) so the bundled status-
// bar ring matches the in-call ring for each selectable option. "none" is
// intentionally absent (it maps to the silent channel, no sound file needed).
const RINGTONE_NOTES = {
    classic: [440, 440],
    calm: [392, 523, 659],
    dynamic: [523, 659, 784, 659],
    urgent: [880, 880, 988],
    boop: [330, 247],
    marimba: [523, 659, 784, 1046],
    crystal: [659, 988, 1318],
    vapor: [392, 523, 659, 784],
};

// Outgoing ringback note frequencies (the OUTGOING_TONES option default).
const RINGBACK_NOTES = [440, 480];

/** Encode a mono Int16 PCM buffer as a 16-bit WAV file (RIFF). */
function encodeWavPcm16(samples) {
    const dataLength = samples.length * 2;
    const buffer = Buffer.alloc(44 + dataLength);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write("WAVE", 8, "ascii");
    buffer.write("fmt ", 12, "ascii");
    buffer.writeUInt32LE(16, 16); // PCM chunk size
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(SAMPLE_RATE, 24);
    buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32); // block align
    buffer.writeUInt16LE(16, 34); // bits per sample
    buffer.write("data", 36, "ascii");
    buffer.writeUInt32LE(dataLength, 40);
    for (let i = 0; i < samples.length; i += 1) {
        buffer.writeInt16LE(samples[i], 44 + i * 2);
    }
    return buffer;
}

/**
 * Render a sequence of notes (each: { freqs:number[], durSec, gapSec }) into a
 * single Float array of [-1,1] samples with a soft attack/decay envelope so it
 * sounds like a pleasant chime rather than a harsh beep.
 */
function renderNotes(notes) {
    const out = [];
    for (const note of notes) {
        const noteSamples = Math.floor(SAMPLE_RATE * note.durSec);
        for (let i = 0; i < noteSamples; i += 1) {
            const t = i / SAMPLE_RATE;
            const attack = Math.min(1, t / 0.02);
            const release = Math.min(1, (note.durSec - t) / 0.08);
            const env = Math.max(0, Math.min(attack, release));
            let value = 0;
            for (const f of note.freqs) {
                if (f > 0) value += Math.sin(2 * Math.PI * f * t);
            }
            const denom = note.freqs.filter((f) => f > 0).length || 1;
            value = (value / denom) * env * 0.6;
            out.push(value);
        }
        const gapSamples = Math.floor(SAMPLE_RATE * (note.gapSec || 0));
        for (let i = 0; i < gapSamples; i += 1) out.push(0);
    }
    return out;
}

/** Convert [-1,1] floats to clamped Int16. */
function toInt16(floats) {
    const pcm = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i += 1) {
        const v = Math.max(-1, Math.min(1, floats[i]));
        pcm[i] = Math.round(v * 32767);
    }
    return pcm;
}

/**
 * Build a looping-friendly INCOMING ringtone from a list of note frequencies.
 * The phrase plays the notes ascending as short dyad-ish chimes, repeats the
 * phrase once for a fuller ring, then appends a trailing pause so the channel
 * loop has a natural "ring … pause … ring" cadence.
 */
function buildRingtoneFromNotes(freqs) {
    const phrase = [];
    for (let i = 0; i < freqs.length; i += 1) {
        // Pair each note with the next for a richer dyad where available.
        const f = freqs[i];
        const next = freqs[i + 1];
        phrase.push({
            freqs: next ? [f, next] : [f],
            durSec: 0.24,
            gapSec: 0.06,
        });
    }
    const notes = [
        ...phrase,
        ...phrase, // repeat once for a fuller ring
        { freqs: [0], durSec: 0.0001, gapSec: 1.0 }, // trailing pause for the loop
    ];
    return toInt16(renderNotes(notes));
}

/**
 * OUTGOING ringback: a simple two-tone "brr-brr" pair with a long pause,
 * approximating the classic telephone ringback cadence.
 */
function buildRingback() {
    const notes = [
        { freqs: RINGBACK_NOTES, durSec: 0.4, gapSec: 0.2 },
        { freqs: RINGBACK_NOTES, durSec: 0.4, gapSec: 1.2 },
    ];
    return toInt16(renderNotes(notes));
}

function main() {
    const outDir = path.join(__dirname, "..", "assets", "sounds");
    fs.mkdirSync(outDir, { recursive: true });

    const files = [];
    // One ringtone file per selectable option.
    for (const [id, freqs] of Object.entries(RINGTONE_NOTES)) {
        files.push([`ringtone_${id}.wav`, buildRingtoneFromNotes(freqs)]);
    }
    // Keep a generic `ringtone.wav` (the default "classic") for safety/back-compat.
    files.push(["ringtone.wav", buildRingtoneFromNotes(RINGTONE_NOTES.classic)]);
    files.push(["ringback.wav", buildRingback()]);

    for (const [name, pcm] of files) {
        const wav = encodeWavPcm16(pcm);
        const outPath = path.join(outDir, name);
        fs.writeFileSync(outPath, wav);
        console.log(
            `wrote ${outPath} (${(wav.length / 1024).toFixed(1)} KiB, ${(pcm.length / SAMPLE_RATE).toFixed(2)}s)`,
        );
    }
}

main();